import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
try{console.log(await readFile(resolve(process.env.BACKUP_DIR||'data/backups','status.json'),'utf8'));}catch{console.error('No backup status yet. Start the API with BACKUP_ENABLED=true.');process.exitCode=1;}
