import {createApp,configuration} from '../server.mjs';
import {openStore} from '../store.mjs';
const args=process.argv.slice(2);const pi=args.indexOf('--port');const port=pi>=0?Number(args[pi+1]):4173;
const config=configuration({...process.env,APP_ORIGIN:process.env.APP_ORIGIN||`http://127.0.0.1:${port}`,PORT:String(port),DATA_PATH:process.env.DATA_PATH||'.local/team.sqlite'});
const store=openStore(config.dbPath);createApp(config,store).listen(port,'0.0.0.0',()=>console.log(`Team preview: http://127.0.0.1:${port}/team/`));
