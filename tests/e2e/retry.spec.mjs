import {test,expect} from '../fixtures.mjs';
test('lost create response can be retried without a duplicate task',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Новая задача',exact:true}).click();const d=page.getByRole('dialog'),title='Lost response '+Date.now();await d.getByLabel('Название',{exact:true}).fill(title);
 const keys=[];let id;await page.route('**/api/tasks?*',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);if(keys.length===1){const r=await route.fetch();expect(r.status()).toBe(201);id=(await r.json()).id;await route.abort('failed');}else await route.continue();});
 await d.getByRole('button',{name:'Создать задачу',exact:true}).click();await expect(d.getByRole('alert')).toBeVisible();await d.getByRole('button',{name:'Создать задачу',exact:true}).click();await expect(d).toHaveCount(0);expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
 const tasks=await(await page.request.get('/api/tasks')).json();expect(tasks.filter(t=>t.title===title)).toHaveLength(1);expect(tasks.find(t=>t.title===title).id).toBe(id);
});
