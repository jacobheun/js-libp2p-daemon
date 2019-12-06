/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 5] */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const os = require('os')
const path = require('path')
const CID = require('cids')
const ma = require('multiaddr')
const delay = require('delay')

const StreamHandler = require('../../src/stream-handler')
const { createDaemon } = require('../../src/daemon')
const { createLibp2p } = require('../../src/libp2p')
const Client = require('../../src/client')
const { isWindows } = require('../../src/util')
const { connect } = require('../util')
const {
  Request,
  DHTRequest,
  Response,
  DHTResponse
} = require('../../src/protocol')

const daemonAddr = isWindows
  ? ma('/ip4/0.0.0.0/tcp/8080')
  : ma(`/unix${path.resolve(os.tmpdir(), '/tmp/p2pd.sock')}`)

describe('dht', () => {
  const cid = new CID('QmVzw6MPsF96TyXBSRs1ptLoVMWRv5FCYJZZGJSVB2Hp38')
  let daemon
  let libp2pPeer
  let client

  before(async function () {
    this.timeout(20e3)
    ;[daemon, libp2pPeer] = await Promise.all([
      createDaemon({
        quiet: false,
        q: false,
        bootstrap: false,
        hostAddrs: '/ip4/0.0.0.0/tcp/0,/ip4/0.0.0.0/tcp/0/ws',
        b: false,
        dht: true,
        dhtClient: false,
        connMgr: false,
        listen: daemonAddr.toString(),
        id: '',
        bootstrapPeers: ''
      }),
      createLibp2p({
        dht: true,
        hostAddrs: '/ip4/0.0.0.0/tcp/0'
      })
    ])
    await Promise.all([
      daemon.start(),
      libp2pPeer.start()
    ])
    await connect({
      libp2pPeer,
      multiaddr: daemonAddr
    })

    // Give the nodes a moment to handshake
    await delay(500)
  })

  after(() => {
    return Promise.all([
      daemon.stop(),
      libp2pPeer.stop()
    ])
  })

  afterEach(async () => {
    await client && client.close()
  })

  it('should be able to find a peer', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.FIND_PEER,
        peer: libp2pPeer.peerInfo.id.toBytes()
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.OK)
    expect(response.dht).to.eql({
      type: DHTResponse.Type.VALUE,
      peer: {
        id: libp2pPeer.peerInfo.id.toBytes(),
        addrs: libp2pPeer.peerInfo.multiaddrs.toArray().map(m => m.buffer)
      },
      value: null
    })
    streamHandler.close()
  })

  it('should be able to register as a provider', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.PROVIDE,
        cid: cid.buffer
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.OK)
    streamHandler.close()

    // The peer should be able to find our daemon as a provider
    const providers = []
    for await (const provider of libp2pPeer.contentRouting.findProviders(cid, { maxNumProviders: 1 })) {
      providers.push(provider)
    }
    expect(daemon.libp2p.peerInfo.id.isEqual(providers[0].id)).to.eql(true)
  })

  it('should be able to find providers', async () => {
    // Register the peer as a provider
    const cid = new CID('QmaSNGNpisJ1UeuoH3WcKuia4hQVi2XkfhkszTbWak9TxB')
    await libp2pPeer.contentRouting.provide(cid)

    // Now find it as a provider
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.FIND_PROVIDERS,
        cid: cid.buffer,
        count: 1
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const expectedResponses = [
      (message) => {
        const response = Response.decode(message)
        expect(response.type).to.eql(Response.Type.OK)
        expect(response.dht).to.eql({
          type: DHTResponse.Type.BEGIN,
          peer: null,
          value: null
        })
      },
      (message) => {
        const response = DHTResponse.decode(message)
        expect(response.type).to.eql(DHTResponse.Type.VALUE)
        expect(response.peer).to.eql({
          id: libp2pPeer.peerInfo.id.toBytes(),
          addrs: libp2pPeer.peerInfo.multiaddrs.toArray().map(m => m.buffer)
        })
      },
      (message) => {
        const response = DHTResponse.decode(message)
        expect(response.type).to.eql(DHTResponse.Type.END)
      }
    ]

    while (true) {
      if (expectedResponses.length === 0) break
      const message = await streamHandler.read()
      expectedResponses.shift()(message.slice())
    }
    streamHandler.close()
  })

  it('should be able to get closest peers to a key', async () => {
    // Now find it as a provider
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.GET_CLOSEST_PEERS,
        key: 'foobar'
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const expectedResponses = [
      (message) => {
        const response = Response.decode(message)
        expect(response.type).to.eql(Response.Type.OK)
        expect(response.dht).to.eql({
          type: DHTResponse.Type.BEGIN,
          peer: null,
          value: null
        })
      },
      (message) => {
        const response = DHTResponse.decode(message)
        expect(response.type).to.eql(DHTResponse.Type.VALUE)
        expect(response.value.toString()).to.eql(libp2pPeer.peerInfo.id.toB58String())
      },
      (message) => {
        const response = DHTResponse.decode(message)
        expect(response.type).to.eql(DHTResponse.Type.END)
      }
    ]

    while (true) {
      if (expectedResponses.length === 0) break
      const message = await streamHandler.read()
      expectedResponses.shift()(message.slice())
    }
    streamHandler.close()
  })

  it('should be able to get the public key of a peer', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.GET_PUBLIC_KEY,
        peer: libp2pPeer.peerInfo.id.toBytes()
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.OK)
    expect(response.dht).to.eql({
      type: DHTResponse.Type.VALUE,
      peer: null,
      value: libp2pPeer.peerInfo.id.pubKey.bytes
    })
    streamHandler.close()
  })

  it('should be able to get a value from the dht', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    await libp2pPeer.contentRouting.put(Buffer.from('/hello'), Buffer.from('world'))

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.GET_VALUE,
        key: '/hello'
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.OK)
    expect(response.dht).to.eql({
      type: DHTResponse.Type.VALUE,
      peer: null,
      value: Buffer.from('world')
    })
    streamHandler.close()
  })

  it('should error when it cannot find a value', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.GET_VALUE,
        key: '/v/doesntexist'
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.ERROR)
    streamHandler.close()
  })

  it('should be able to put a value to the dht', async () => {
    client = new Client(daemonAddr)

    const maConn = await client.connect()
    const streamHandler = new StreamHandler({ stream: maConn })

    const request = {
      type: Request.Type.DHT,
      connect: null,
      streamOpen: null,
      streamHandler: null,
      dht: {
        type: DHTRequest.Type.PUT_VALUE,
        key: '/hello2',
        value: Buffer.from('world2')
      },
      disconnect: null,
      pubsub: null,
      connManager: null
    }

    streamHandler.write(Request.encode(request))

    const response = Response.decode(await streamHandler.read())
    expect(response.type).to.eql(Response.Type.OK)
    expect(response.dht).to.eql(null)
    streamHandler.close()

    const value = await libp2pPeer.contentRouting.get(Buffer.from('/hello2'))
    expect(value).to.eql(Buffer.from('world2'))
  })
})
