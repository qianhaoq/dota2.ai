#!/usr/bin/env node
/**
 * Checks proto/dota_retriever.proto against Valve's current definitions
 * (SteamDatabase/Protobufs): every field we declare must exist upstream with
 * the same number, and the same type unless upstream's is an enum (declared
 * here as a varint). Message ids are checked too. Exits 1 on any difference.
 * Run it when the GC starts answering with data that no longer decodes.
 */
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { MSG } from '../src/codec.mjs';

const BASE = process.env.PROTO_BASE || 'https://raw.githubusercontent.com/SteamDatabase/Protobufs/master/dota2';
const FILES = ['dota_gcmessages_client.proto', 'dota_gcmessages_common.proto', 'dota_gcmessages_msgid.proto', 'gcsystemmsgs.proto'];
const IDS = {
  clientWelcome: 'k_EMsgGCClientWelcome', clientHello: 'k_EMsgGCClientHello', clientConnectionStatus: 'k_EMsgGCClientConnectionStatus',
  matchDetailsRequest: 'k_EMsgGCMatchDetailsRequest', matchDetailsResponse: 'k_EMsgGCMatchDetailsResponse',
  playerMatchHistory: 'k_EMsgDOTAGetPlayerMatchHistory', playerMatchHistoryResponse: 'k_EMsgDOTAGetPlayerMatchHistoryResponse',
};
const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);

const upstream = new protobuf.Root();
for (const file of FILES) {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) { console.error(`could not fetch ${file}: HTTP ${res.status}`); process.exit(1); }
  protobuf.parse(await res.text(), upstream, { keepCase: true });
}
const ours = protobuf.parse(readFileSync(new URL('../proto/dota_retriever.proto', import.meta.url), 'utf8'), { keepCase: true }).root;

const problems = [];
let checked = 0;
function walk(ns, path) {
  for (const type of ns.nestedArray) {
    if (!(type instanceof protobuf.Type)) continue;
    const name = [...path, type.name].join('.');
    const theirs = upstream.lookup(name);
    if (!(theirs instanceof protobuf.Type)) { problems.push(`${name}: not found upstream`); continue; }
    for (const field of type.fieldsArray) {
      checked += 1;
      const other = theirs.fields[field.name];
      const leaf = (t) => t.split('.').pop();
      if (!other) problems.push(`${name}.${field.name}: not found upstream`);
      else if (other.id !== field.id) problems.push(`${name}.${field.name}: number ${field.id} here, ${other.id} upstream`);
      else if (Boolean(other.repeated) !== Boolean(field.repeated)) problems.push(`${name}.${field.name}: repeated differs`);
      else if (SCALARS.has(other.type) ? other.type !== field.type
        : SCALARS.has(field.type) ? !['uint32', 'int32'].includes(field.type) || upstream.lookup(leaf(other.type)) instanceof protobuf.Type
          : leaf(other.type) !== leaf(field.type)) problems.push(`${name}.${field.name}: type ${field.type} here, ${other.type} upstream`);
    }
    walk(type, [...path, type.name]);
  }
}
walk(ours, []);
for (const [key, enumName] of Object.entries(IDS)) {
  checked += 1;
  const holder = upstream.nestedArray.find((n) => n instanceof protobuf.Enum && n.values[enumName] !== undefined);
  if (!holder) problems.push(`${enumName}: not found upstream`);
  else if (holder.values[enumName] !== MSG[key]) problems.push(`${enumName}: ${MSG[key]} here, ${holder.values[enumName]} upstream`);
}

if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} difference(s) in ${checked} checks.`); process.exit(1); }
console.log(`proto subset matches upstream (${checked} checks).`);
