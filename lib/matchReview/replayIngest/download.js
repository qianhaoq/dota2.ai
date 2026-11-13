import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {isReplayUrl} from './discovery.js';
export function classifyReplayAddress(address){
 const family=isIP(address);
 if(family===4){
  const [a,b,c]=address.split('.').map(Number);
  if(a===0)return 'unspecified';
  if(a===127)return 'loopback';
  if(a===169&&b===254)return 'link_local';
  if(a===10||a===172&&b>=16&&b<=31||a===192&&b===168)return 'private';
  if(a===100&&b>=64&&b<=127)return 'shared';
  if(a===198&&(b===18||b===19))return 'benchmark';
  if(a===192&&b===0&&c===2||a===198&&b===51&&c===100||a===203&&b===0&&c===113)return 'documentation';
  if(a===192&&b===0||a===192&&b===88&&c===99)return 'other';
  if(a>=224)return 'multicast';
  return 'public_v4';
 }
 if(family!==6)return 'other';
 let value=address.toLowerCase().split('%')[0];
 if(value.includes('.'))value=value.replace(/\d+\.\d+\.\d+\.\d+$/,v=>{const p=v.split('.').map(Number);return `${(p[0]*256+p[1]).toString(16)}:${(p[2]*256+p[3]).toString(16)}`;});
 const halves=value.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
 const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(v=>parseInt(v,16));
 const zero=n=>words.slice(0,n).every(v=>v===0);
 if(zero(6)||zero(5)&&words[5]===0xffff||words[0]===0x64&&words[1]===0xff9b&&words.slice(2,6).every(v=>v===0)){
  if(zero(6)){if(words[6]===0&&words[7]===0)return 'unspecified';if(words[6]===0&&words[7]===1)return 'loopback';return 'other';}
  return classifyReplayAddress(`${words[6]>>8}.${words[6]&255}.${words[7]>>8}.${words[7]&255}`);
 }
 if((words[0]&0xffc0)===0xfe80)return 'link_local';
 if((words[0]&0xfe00)===0xfc00)return 'private';
 if((words[0]&0xff00)===0xff00)return 'multicast';
 if(words[0]===0x2001&&words[1]===0xdb8)return 'documentation';
 if(words[0]===0x2001&&words[1]===2&&words[2]===0)return 'benchmark';
 if(words[0]===0x100&&words.slice(1,4).every(v=>v===0))return 'other';
 return (words[0]&0xe000)===0x2000?'public_v6':'other';
}
export function isPublicReplayV4(address){return isIP(address)===4&&classifyReplayAddress(address)==='public_v4';}
export function selectPublicReplayAddress(addresses=[],policy='ipv4-preferred'){
 if(policy!=='ipv4-preferred')throw new Error('invalid_replay_dns_policy');
 const v4=addresses.find(a=>isPublicReplayV4(a.address));
 if(v4)return {...v4,family:4};
 // IPv6 fallback requires a wholly public set; mixed benchmark/private + AAAA fails closed.
 if(addresses.length&&addresses.every(a=>['public_v4','public_v6'].includes(classifyReplayAddress(a.address)))){
  const v6=addresses.find(a=>isIP(a.address)===6);if(v6)return {...v6,family:6};
 }
 return null;
}
export function summarizeReplayDns(addresses=[],selected){
 const counts={};for(const a of addresses){const kind=classifyReplayAddress(a.address);counts[kind]=(counts[kind]??0)+1;}
 return {counts,selected_family:selected?.family??null,selected_class:selected?classifyReplayAddress(selected.address):null,...(!selected?{rejected_reason:'replay_dns_not_public'}:{})};
}
// Resolve at the connection, never validate DNS and then resolve a second time.
/** @param {(host: string, options: {all: boolean}, callback: Function) => void} [resolve] */
export function createPublicReplayLookup(resolve=lookup){return (host,options,callback)=>resolve(host,{all:true},(error,addresses=[])=>{
 const a=error?null:selectPublicReplayAddress(addresses),dns=summarizeReplayDns(addresses,a);
 if(error){error.dns=dns;return callback(error);}
 if(!a)return callback(Object.assign(new Error('replay_dns_not_public'),{dns}));
 console.error('replay_dns_selected',host,a.address,dns);
 callback(null,options?.all?[a]:a.address,a.family);
 });}
export const publicReplayLookup=createPublicReplayLookup();
/** @param {string} url @param {{signal?: AbortSignal, lookup?: (host: string, options: {all: boolean}, callback: Function) => void}} [options] */
export function fetchReplay(url,{signal,lookup:resolve=lookup}={}){
 if(!isReplayUrl(url))return Promise.reject(new Error('invalid_replay_url'));
 return new Promise((resolveResponse,reject)=>{
 // http(s).get returns 3xx directly: Location is never followed.
 const req=(url.toLowerCase().startsWith('https:')?https:http).get(url,{signal,lookup:createPublicReplayLookup(resolve)},res=>resolveResponse({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,body:Readable.toWeb(res)}));req.on('error',reject);});
}
