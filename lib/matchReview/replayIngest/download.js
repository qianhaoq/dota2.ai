import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {isReplayUrl} from './discovery.js';
export function isPublicReplayV4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
}
// Ignore AAAA/private/benchmark addresses; connect only to a public IPv4.
// Node's all:true lookup includes AAAA, and rejecting the whole set made
// official valve.net fetches fail as replay_dns_not_public from Cloud Run.
export function selectPublicReplayAddress(addresses=[]){return addresses.find(a=>isPublicReplayV4(a.address))??null;}
// Resolve at the connection, never validate DNS and then resolve a second time.
export function publicReplayLookup(host,options,callback){lookup(host,{all:true},(error,addresses)=>{
 if(error)return callback(error);
 const a=selectPublicReplayAddress(addresses);
 if(!a)return callback(new Error('replay_dns_not_public'));
 callback(null,options?.all?[a]:a.address,a.family);
 });}
export function fetchReplay(url,{signal}={}){
 if(!isReplayUrl(url))return Promise.reject(new Error('invalid_replay_url'));
 return new Promise((resolve,reject)=>{const transport=url.startsWith('https:')?https:http;
 const req=transport.get(url,{signal,lookup:publicReplayLookup},res=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,body:Readable.toWeb(res)}));req.on('error',reject);});
}
