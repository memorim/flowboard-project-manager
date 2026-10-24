import {createServer} from 'node:http';
import {createApp} from '../server/app.ts';
import {createDatabase} from '../server/db.ts';
let db=createDatabase(':memory:'),app=createApp(db);
// Test-only loopback server. Reset creates a fresh synthetic DB; no production reset route exists.
createServer((req,res)=>{
 if(req.method==='POST'&&req.url==='/__test/reset'){db.close();db=createDatabase(':memory:');app=createApp(db);res.writeHead(204).end();return;}
 app(req,res);
}).listen(4140,'127.0.0.1');
