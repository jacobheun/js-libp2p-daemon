'use strict'

const protobuf = require('protons')
module.exports = protobuf(`
message Request {
  enum Type {
    IDENTIFY       = 0;
    CONNECT        = 1;
    STREAM_OPEN    = 2;
    STREAM_HANDLER = 3;
    DHT            = 4;
    LIST_PEERS     = 5;
    CONNMANAGER    = 6;
    DISCONNECT     = 7;
    PUBSUB         = 8;
  }

  required Type type = 1;

  optional ConnectRequest connect = 2;
  optional StreamOpenRequest streamOpen = 3;
  optional StreamHandlerRequest streamHandler = 4;
  optional DHTRequest dht = 5;
  optional ConnManagerRequest connManager = 6;
  optional DisconnectRequest disconnect = 7;
  optional PSRequest pubsub = 8;
}

message Response {
  enum Type {
    OK    = 0;
    ERROR = 1;
  }

  required Type type = 1;
  optional ErrorResponse error = 2;
  optional StreamInfo streamInfo = 3;
  optional IdentifyResponse identify = 4;
  optional DHTResponse dht = 5;
  repeated PeerInfo peers = 6;
  optional PSResponse pubsub = 7;
}

message IdentifyResponse {
  required bytes id = 1;
  repeated bytes addrs = 2;
}

message ConnectRequest {
  required bytes peer = 1;
  repeated bytes addrs = 2;
}

message StreamOpenRequest {
  required bytes peer = 1;
  repeated string proto = 2;
}

message StreamHandlerRequest {
  required string path = 1;
  repeated string proto = 2;
}

message ErrorResponse {
  required string msg = 1;
}

message StreamInfo {
  required bytes peer = 1;
  required bytes addr = 2;
  required string proto = 3;
}

message DHTRequest {
  enum Type {
    FIND_PEER                    = 0;
    FIND_PEERS_CONNECTED_TO_PEER = 1;
    FIND_PROVIDERS               = 2;
    GET_CLOSEST_PEERS            = 3;
    GET_PUBLIC_KEY               = 4;
    GET_VALUE                    = 5;
    SEARCH_VALUE                 = 6;
    PUT_VALUE                    = 7;
    PROVIDE                      = 8;
  }

  required Type type = 1;
  optional bytes peer = 2;
  optional bytes cid = 3;
  optional string key = 4;
  optional bytes value = 5;
  optional int32 count = 6;
  optional int64 timeout = 7;
}

message DHTResponse {
  enum Type {
    BEGIN = 0;
    VALUE = 1;
    END   = 2;
  }

  required Type type = 1;
  optional PeerInfo peer = 2;
  optional bytes value = 3;
}

message PeerInfo {
  required bytes id = 1;
  repeated bytes addrs = 2;
}

message ConnManagerRequest {
  enum Type {
    TAG_PEER   = 0;
    UNTAG_PEER = 1;
    TRIM       = 2;
  }

  required Type type = 1;

  optional bytes peer = 2;
  optional string tag = 3;
  optional int64 weight = 4;
}

message DisconnectRequest {
  required bytes peer = 1;
}

message PSRequest {
  enum Type {
    GET_TOPICS = 0;
    LIST_PEERS = 1;
    PUBLISH    = 2;
    SUBSCRIBE  = 3;
  }

  required Type type = 1;
  optional string topic = 2;
  optional bytes data = 3;
}

message PSMessage {
  repeated bytes from = 1;
  repeated bytes data = 2;
  repeated bytes seqno = 3;
  repeated bytes topicIDs = 4;
  repeated bytes signature = 5;
  repeated bytes key = 6;
}

message PSResponse {
  repeated string topics = 1;
  repeated bytes peerIDs = 2;
}
`)
