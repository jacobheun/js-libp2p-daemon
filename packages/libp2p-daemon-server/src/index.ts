/* eslint max-depth: ["error", 6] */

import {
  Request,
  DHTRequest,
  PeerstoreRequest,
  PSRequest,
  StreamInfo
} from '@libp2p/daemon-protocol'
import { StreamHandler } from '@libp2p/daemon-protocol/stream-handler'
import { passThroughUpgrader } from '@libp2p/daemon-protocol/upgrader'
import { defaultLogger, logger } from '@libp2p/logger'
import { peerIdFromBytes } from '@libp2p/peer-id'
import { tcp } from '@libp2p/tcp'
import { multiaddr, protocols } from '@multiformats/multiaddr'
import * as lp from 'it-length-prefixed'
import { pipe } from 'it-pipe'
import { CID } from 'multiformats/cid'
import { DHTOperations } from './dht.js'
import { PubSubOperations } from './pubsub.js'
import { ErrorResponse, OkResponse } from './responses.js'
import type { GossipSub } from '@chainsafe/libp2p-gossipsub'
import type { Libp2p } from '@libp2p/interface'
import type { Connection, MultiaddrConnection, Stream } from '@libp2p/interface/connection'
import type { Listener, Transport } from '@libp2p/interface/transport'
import type { KadDHT } from '@libp2p/kad-dht'
import type { Multiaddr } from '@multiformats/multiaddr'

const LIMIT = 1 << 22 // 4MB
const log = logger('libp2p:daemon-server')

export interface OpenStream {
  streamInfo: StreamInfo
  connection: Stream
}

export interface DaemonInit {
  multiaddr: Multiaddr
  libp2pNode: Libp2p<{ dht: KadDHT, pubsub: GossipSub }>
}

export interface Libp2pServer {
  start(): Promise<void>
  stop(): Promise<void>
  getMultiaddr(): Multiaddr
}

export class Server implements Libp2pServer {
  private readonly multiaddr: Multiaddr
  private readonly libp2p: Libp2p<{ dht: KadDHT, pubsub: GossipSub }>
  private readonly tcp: Transport
  private readonly listener: Listener
  private readonly dhtOperations?: DHTOperations
  private readonly pubsubOperations?: PubSubOperations

  constructor (init: DaemonInit) {
    const { multiaddr, libp2pNode } = init

    this.multiaddr = multiaddr
    this.libp2p = libp2pNode
    this.tcp = tcp()({
      // @ts-expect-error this field will be present post v1
      logger: defaultLogger()
    })
    this.listener = this.tcp.createListener({
      handler: this.handleConnection.bind(this),
      upgrader: passThroughUpgrader
    })
    this._onExit = this._onExit.bind(this)

    if (libp2pNode.services.dht != null) {
      this.dhtOperations = new DHTOperations({ dht: libp2pNode.services.dht })
    }

    if (libp2pNode.services.pubsub != null) {
      this.pubsubOperations = new PubSubOperations({ pubsub: libp2pNode.services.pubsub })
    }
  }

  /**
   * Connects the daemons libp2p node to the peer provided
   */
  async connect (request: Request): Promise<Connection> {
    if (request.connect == null || request.connect.addrs == null) {
      throw new Error('Invalid request')
    }

    const peer = request.connect.peer
    const addrs = request.connect.addrs.map((a) => multiaddr(a))
    const peerId = peerIdFromBytes(peer)

    log('connect - adding multiaddrs %a to peer %p', addrs, peerId)
    await this.libp2p.peerStore.merge(peerId, {
      multiaddrs: addrs
    })

    log('connect - dial %p', peerId)
    return this.libp2p.dial(peerId)
  }

  /**
   * Opens a stream on one of the given protocols to the given peer
   */
  async openStream (request: Request): Promise<OpenStream> {
    if (request.streamOpen == null || request.streamOpen.proto == null) {
      throw new Error('Invalid request')
    }

    const { peer, proto } = request.streamOpen
    const peerId = peerIdFromBytes(peer)

    log('openStream - dial %p', peerId)
    const connection = await this.libp2p.dial(peerId)

    log('openStream - open stream for protocol %s', proto)
    const stream = await connection.newStream(proto, {
      runOnTransientConnection: true
    })

    return {
      streamInfo: {
        peer: peerId.toBytes(),
        addr: connection.remoteAddr.bytes,
        proto: stream.protocol ?? ''
      },
      connection: stream
    }
  }

  /**
   * Sends inbound requests for the given protocol
   * to the unix socket path provided. If an existing handler
   * is registered at the path, it will be overridden.
   */
  async registerStreamHandler (request: Request): Promise<void> {
    if (request.streamHandler == null || request.streamHandler.proto == null) {
      throw new Error('Invalid request')
    }

    const protocols = request.streamHandler.proto
    const addr = multiaddr(request.streamHandler.addr)
    let conn: MultiaddrConnection

    log('registerStreamHandler - handle %s', protocols)
    await this.libp2p.handle(protocols, ({ connection, stream }) => {
      Promise.resolve()
        .then(async () => {
          // Connect the client socket with the libp2p connection
          // @ts-expect-error because we use a passthrough upgrader,
          // this is actually a MultiaddrConnection and not a Connection
          conn = await this.tcp.dial(addr, {
            upgrader: passThroughUpgrader
          })

          const message = StreamInfo.encode({
            peer: connection.remotePeer.toBytes(),
            addr: connection.remoteAddr.bytes,
            proto: stream.protocol ?? ''
          })
          const encodedMessage = lp.encode.single(message)

          // Tell the client about the new connection
          // And then begin piping the client and peer connection
          await pipe(
            (async function * () {
              yield encodedMessage
              yield * stream.source
            }()),
            async function * (source) {
              for await (const list of source) {
                // convert Uint8ArrayList to Uint8Arrays for the socket
                yield * list
              }
            },
            conn,
            stream.sink
          )
        })
        .catch(async err => {
          log.error(err)

          if (conn != null) {
            await conn.close(err)
          }
        })
        .finally(() => {
          if (conn != null) {
            conn.close()
              .catch(err => {
                log.error(err)
              })
          }
        })
    }, {
      runOnTransientConnection: true
    })
  }

  /**
   * Listens for process exit to handle cleanup
   */
  _listen (): void {
    // listen for graceful termination
    process.on('SIGTERM', this._onExit)
    process.on('SIGINT', this._onExit)
    process.on('SIGHUP', this._onExit)
  }

  _onExit (): void {
    void this.stop({ exit: true }).catch(err => {
      log.error(err)
    })
  }

  /**
   * Starts the daemon
   */
  async start (): Promise<void> {
    this._listen()
    await this.libp2p.start()
    await this.listener.listen(this.multiaddr)
  }

  getMultiaddr (): Multiaddr {
    const addrs = this.listener.getAddrs()

    if (addrs.length > 0) {
      return addrs[0]
    }

    throw new Error('Not started')
  }

  /**
   * Stops the daemon
   */
  async stop (options = { exit: false }): Promise<void> {
    await this.libp2p.stop()
    await this.listener.close()
    if (options.exit) {
      log('server closed, exiting')
    }
    process.removeListener('SIGTERM', this._onExit)
    process.removeListener('SIGINT', this._onExit)
    process.removeListener('SIGHUP', this._onExit)
  }

  async * handlePeerStoreRequest (request: PeerstoreRequest): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      switch (request.type) {
        case PeerstoreRequest.Type.GET_PROTOCOLS:
          if (request.id == null) {
            throw new Error('Invalid request')
          }

          const peerId = peerIdFromBytes(request.id) // eslint-disable-line no-case-declarations
          const peer = await this.libp2p.peerStore.get(peerId) // eslint-disable-line no-case-declarations
          const protos = peer.protocols // eslint-disable-line no-case-declarations
          yield OkResponse({ peerStore: { protos } })
          return
        case PeerstoreRequest.Type.GET_PEER_INFO:
          throw new Error('ERR_NOT_IMPLEMENTED')
        default:
          throw new Error('ERR_INVALID_REQUEST_TYPE')
      }
    } catch (err: any) {
      log.error(err)
      yield ErrorResponse(err)
    }
  }

  /**
   * Parses and responds to PSRequests
   */
  async * handlePubsubRequest (request: PSRequest): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      if (this.libp2p.services.pubsub == null || (this.pubsubOperations == null)) {
        throw new Error('PubSub not configured')
      }

      switch (request.type) {
        case PSRequest.Type.GET_TOPICS:
          yield * this.pubsubOperations.getTopics()
          return
        case PSRequest.Type.SUBSCRIBE:
          if (request.topic == null) {
            throw new Error('Invalid request')
          }

          yield * this.pubsubOperations.subscribe(request.topic)
          return
        case PSRequest.Type.PUBLISH:
          if (request.topic == null || request.data == null) {
            throw new Error('Invalid request')
          }

          yield * this.pubsubOperations.publish(request.topic, request.data)
          return
        case PSRequest.Type.LIST_PEERS:
          if (request.topic == null) {
            throw new Error('Invalid request')
          }

          yield * this.pubsubOperations.listPeers(request.topic)
          return
        default:
          throw new Error('ERR_INVALID_REQUEST_TYPE')
      }
    } catch (err: any) {
      log.error(err)
      yield ErrorResponse(err)
    }
  }

  /**
   * Parses and responds to DHTRequests
   */
  async * handleDHTRequest (request: DHTRequest): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      if (this.libp2p.services.dht == null || (this.dhtOperations == null)) {
        throw new Error('DHT not configured')
      }

      switch (request.type) {
        case DHTRequest.Type.FIND_PEER:
          if (request.peer == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.findPeer(peerIdFromBytes(request.peer))
          return
        case DHTRequest.Type.FIND_PROVIDERS:
          if (request.cid == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.findProviders(CID.decode(request.cid), request.count ?? 20)
          return
        case DHTRequest.Type.PROVIDE:
          if (request.cid == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.provide(CID.decode(request.cid))
          return
        case DHTRequest.Type.GET_CLOSEST_PEERS:
          if (request.key == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.getClosestPeers(request.key)
          return
        case DHTRequest.Type.GET_PUBLIC_KEY:
          if (request.peer == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.getPublicKey(peerIdFromBytes(request.peer))
          return
        case DHTRequest.Type.GET_VALUE:
          if (request.key == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.getValue(request.key)
          return
        case DHTRequest.Type.PUT_VALUE:
          if (request.key == null || request.value == null) {
            throw new Error('Invalid request')
          }

          yield * this.dhtOperations.putValue(request.key, request.value)
          return
        default:
          throw new Error('ERR_INVALID_REQUEST_TYPE')
      }
    } catch (err: any) {
      log.error(err)
      yield ErrorResponse(err)
    }
  }

  /**
   * Handles requests for the given connection
   */
  handleConnection (connection: Connection): void {
    const daemon = this // eslint-disable-line @typescript-eslint/no-this-alias
    // @ts-expect-error connection may actually be a maconn?
    const streamHandler = new StreamHandler({ stream: connection, maxLength: LIMIT })

    void pipe(
      streamHandler.decoder,
      source => (async function * () {
        let request: Request

        for await (const buf of source) {
          try {
            request = Request.decode(buf)

            switch (request.type) {
              // Connect to another peer
              case Request.Type.CONNECT: {
                try {
                  await daemon.connect(request)
                } catch (err: any) {
                  yield ErrorResponse(err)
                  break
                }
                yield OkResponse()
                break
              }
              // Get the daemon peer id and addresses
              case Request.Type.IDENTIFY: {
                yield OkResponse({
                  identify: {
                    id: daemon.libp2p.peerId.toBytes(),
                    addrs: daemon.libp2p.getMultiaddrs().map(ma => ma.decapsulateCode(protocols('p2p').code)).map(m => m.bytes)
                  }
                })
                break
              }
              // Get a list of our current peers
              case Request.Type.LIST_PEERS: {
                const peers = []
                const seen = new Set<string>()

                for (const connection of daemon.libp2p.getConnections()) {
                  const peerId = connection.remotePeer.toString()

                  if (seen.has(peerId)) {
                    continue
                  }

                  seen.add(peerId)

                  peers.push({
                    id: connection.remotePeer.toBytes(),
                    addrs: [connection.remoteAddr.bytes]
                  })
                }

                yield OkResponse({ peers })
                break
              }
              case Request.Type.STREAM_OPEN: {
                let response
                try {
                  response = await daemon.openStream(request)
                } catch (err: any) {
                  yield ErrorResponse(err)
                  break
                }

                // write the response
                yield OkResponse({
                  streamInfo: response.streamInfo
                })

                const stream = streamHandler.rest()
                // then pipe the connection to the client
                await pipe(
                  stream,
                  response.connection,
                  async function * (source) {
                    for await (const list of source) {
                      yield * list
                    }
                  },
                  stream
                )
                // Exit the iterator, no more requests can come through
                return
              }
              case Request.Type.STREAM_HANDLER: {
                try {
                  await daemon.registerStreamHandler(request)
                } catch (err: any) {
                  yield ErrorResponse(err)
                  break
                }

                // write the response
                yield OkResponse()
                break
              }
              case Request.Type.PEERSTORE: {
                if (request.peerStore == null) {
                  yield ErrorResponse(new Error('ERR_INVALID_REQUEST'))
                  break
                }

                yield * daemon.handlePeerStoreRequest(request.peerStore)
                break
              }
              case Request.Type.PUBSUB: {
                if (request.pubsub == null) {
                  yield ErrorResponse(new Error('ERR_INVALID_REQUEST'))
                  break
                }

                yield * daemon.handlePubsubRequest(request.pubsub)
                break
              }
              case Request.Type.DHT: {
                if (request.dht == null) {
                  yield ErrorResponse(new Error('ERR_INVALID_REQUEST'))
                  break
                }

                yield * daemon.handleDHTRequest(request.dht)
                break
              }
              // Not yet supported or doesn't exist
              default:
                yield ErrorResponse(new Error('ERR_INVALID_REQUEST_TYPE'))
                break
            }
          } catch (err: any) {
            log.error(err)
            yield ErrorResponse(err)
            continue
          }
        }
      })(),
      async function (source) {
        for await (const result of source) {
          streamHandler.write(result)
        }
      }
    ).catch(err => {
      log(err)
    })
  }
}

/**
 * Creates a daemon from the provided Daemon Options
 */
export const createServer = (multiaddr: Multiaddr, libp2pNode: Libp2p<{ dht: KadDHT, pubsub: GossipSub }>): Libp2pServer => {
  const daemon = new Server({
    multiaddr,
    libp2pNode
  })

  return daemon
}
