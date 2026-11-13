#!/usr/bin/env node
import {createServer} from 'node:http';
import {createReplayIngest} from '../lib/matchReview/replayIngest/index.js';
const ingest=createReplayIngest();
if(!ingest.async)throw new Error('Worker requires a job store, REPLAY_INGEST_ENABLED=1, and DOTA_EXTRACT_BIN (or COACH_EXTRACT_BIN)');
if(process.argv.includes('--serve')){
 // Keep the request open while draining so Cloud Run allocates CPU. Hosting must
 // require IAM authentication; this process is never a public submit endpoint.
 let running=null;
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){res.end('ok');return;}
  if(req.method!=='POST'||req.url!=='/run'){res.writeHead(404);res.end();return;}
  req.resume();
  try{running??=ingest.drain().finally(()=>{running=null;});await running;res.end('drained');}
  catch{res.writeHead(500);res.end('retry');}
 });
 server.requestTimeout=900000;
 server.listen(Number(process.env.PORT??8080),'0.0.0.0');
}else{
 let stopping=false;
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 do{await ingest.drain();if(process.argv.includes('--once'))break;if(!stopping)await new Promise(r=>setTimeout(r,1000));}while(!stopping);
}
