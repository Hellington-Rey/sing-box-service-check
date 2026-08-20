"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.join(__dirname, "..", "src", "luci", "55_vless_converter.part");
const source = fs.readFileSync(sourcePath, "utf8") +
  "\n;globalThis.__vlessConverter = { vlessOutboundFromUri, vlessUriFromOutbound };";
vm.runInThisContext(source, { filename: sourcePath });

const { vlessOutboundFromUri, vlessUriFromOutbound } = globalThis.__vlessConverter;
const uuid = "bf000d23-0752-40b4-affe-68f7707a9661";

const realityUri = "vless://" + uuid +
  "@edge.example:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision" +
  "&sni=www.example.com&fp=chrome&pbk=public-key_123&sid=0123abcd&packetEncoding=xudp#Reality%20RU";
const reality = vlessOutboundFromUri(realityUri);
assert.deepStrictEqual(reality, {
  type: "vless",
  tag: "Reality RU",
  server: "edge.example",
  server_port: 443,
  uuid,
  flow: "xtls-rprx-vision",
  packet_encoding: "xudp",
  tls: {
    enabled: true,
    server_name: "www.example.com",
    utls: { enabled: true, fingerprint: "chrome" },
    reality: { enabled: true, public_key: "public-key_123", short_id: "0123abcd" },
  },
});
assert.deepStrictEqual(vlessOutboundFromUri(vlessUriFromOutbound(reality)), reality);

const ws = vlessOutboundFromUri("vless://" + uuid +
  "@[2001:db8::1]:8443?encryption=none&security=tls&type=ws&sni=cdn.example" +
  "&alpn=h2%2Chttp%2F1.1&allowInsecure=1&host=origin.example&path=%2Fsocket%3Fed%3D2048" +
  "&ed=2048&eh=Sec-WebSocket-Protocol#WS");
assert.strictEqual(ws.server, "2001:db8::1");
assert.deepStrictEqual(ws.tls.alpn, ["h2", "http/1.1"]);
assert.strictEqual(ws.tls.insecure, true);
assert.deepStrictEqual(ws.transport, {
  type: "ws",
  path: "/socket?ed=2048",
  headers: { Host: "origin.example" },
  max_early_data: 2048,
  early_data_header_name: "Sec-WebSocket-Protocol",
});
const wsRoundTrip = vlessOutboundFromUri(vlessUriFromOutbound({ outbounds: [ws] }));
assert.deepStrictEqual(wsRoundTrip, ws);

const grpcDocument = {
  log: { level: "info" },
  outbounds: [{
    type: "vless",
    tag: "gRPC сервер",
    server: "grpc.example",
    server_port: 443,
    uuid,
    tls: { enabled: true, server_name: "grpc.example" },
    transport: { type: "grpc", service_name: "Tunnel-Service" },
  }],
};
const grpcUri = vlessUriFromOutbound(grpcDocument);
assert.match(grpcUri, /^vless:\/\//);
assert.strictEqual(new URL(grpcUri).searchParams.get("serviceName"), "Tunnel-Service");
assert.strictEqual(vlessOutboundFromUri(grpcUri).tag, "gRPC сервер");

assert.throws(() => vlessOutboundFromUri("https://example.com"), /vless:\/\//);
assert.throws(() => vlessOutboundFromUri("vless://bad@example.com:443"), /UUID/);
assert.throws(() => vlessOutboundFromUri("vless://" + uuid + "@example.com:443?security=reality"), /pbk/);
assert.throws(() => vlessUriFromOutbound({ outbounds: [] }), /ровно один/);
assert.throws(() => vlessUriFromOutbound({
  type: "vless", server: "example.com", server_port: 443, uuid, transport: { type: "xhttp" },
}), /Транспорт xhttp/);

console.log("VLESS converter tests OK");

