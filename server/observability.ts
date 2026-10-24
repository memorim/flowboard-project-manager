import type {RequestHandler,ErrorRequestHandler} from 'express';
import {safePath,writeLog,type LogSink} from '../src/observability.js';
export {writeLog,type LogSink} from '../src/observability.js';
export const requestLog=(log:LogSink=writeLog):RequestHandler=>(req,res,next)=>{
 if(!req.path.startsWith('/api'))return next();
 const requestId=crypto.randomUUID(),start=performance.now(),path=safePath(req.originalUrl.split('?')[0]);res.locals.requestId=requestId;res.set('X-Request-Id',requestId);
 res.once('finish',()=>log({event:'http_request',requestId,method:req.method,path,status:res.statusCode,durationMs:Number((performance.now()-start).toFixed(2)),...(res.statusCode>=500?{error:'service_unavailable'}:{})}));next();
};
export const safeError:ErrorRequestHandler=(error,_req,res,next)=>{
 if(res.headersSent)return next(error);
 const status=error?.type==='entity.too.large'?413:error instanceof SyntaxError&&'status' in error&&error.status===400?400:503;
 res.status(status).json({message:status===413?'Слишком большой запрос':status===400?'Некорректный JSON':'Сервис временно недоступен. Повторите запрос.'});
};
