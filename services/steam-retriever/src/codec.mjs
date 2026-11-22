/**
 * Protobuf encode/decode for the GC messages this service uses, and the
 * message ids. Decoded objects carry only the fields the GC actually sent
 * (no defaults filled in: an absent field stays absent, so the consumer can
 * tell "0" from "not sent"), uint64 as decimal strings, enums as numbers.
 */
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export const DOTA_APPID = 570;
/** Message ids (gcsystemmsgs.proto, dota_gcmessages_msgid.proto). */
export const MSG = Object.freeze({
  clientWelcome: 4004,
  clientHello: 4006,
  clientConnectionStatus: 4009,
  matchDetailsRequest: 7095,
  matchDetailsResponse: 7096,
  playerMatchHistory: 7408,
  playerMatchHistoryResponse: 7409,
});

const root = new protobuf.Root().loadSync(
  fileURLToPath(new URL('../proto/dota_retriever.proto', import.meta.url)),
  { keepCase: true },
);
const T = {
  matchReq: root.lookupType('CMsgGCMatchDetailsRequest'),
  matchRes: root.lookupType('CMsgGCMatchDetailsResponse'),
  histReq: root.lookupType('CMsgDOTAGetPlayerMatchHistory'),
  histRes: root.lookupType('CMsgDOTAGetPlayerMatchHistoryResponse'),
};
const plain = (type, buf) => type.toObject(type.decode(buf), { longs: String, enums: Number });
const bytes = (type, obj) => Buffer.from(type.encode(type.fromObject(obj)).finish());

export const encodeMatchDetailsRequest = (matchId) => bytes(T.matchReq, { match_id: String(matchId) });
export const decodeMatchDetailsResponse = (buf) => plain(T.matchRes, buf);
export const encodeHistoryRequest = ({ accountId, limit, requestId }) => bytes(T.histReq, {
  account_id: accountId, matches_requested: limit, request_id: requestId,
});
export const decodeHistoryResponse = (buf) => plain(T.histRes, buf);

/** For tests and the proto check: the loaded types. */
export const types = T;
