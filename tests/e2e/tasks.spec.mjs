import {test,expect} from '@playwright/test';
async function nav(page,name){const target=page.getByRole('navigation').getByRole('button',{name:name==='Задачи'?/^Задачи/:name,exact:name!=='Задачи'});if(page.viewportSize().width<=760 && await page.getByRole('button',{name:'Переключить меню'}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'Переключить меню'}).click();await target.click();}
test('create, edit, filter and move a task with persistence and a real activity log',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'Рабочее пространство команды'})).toBeVisible();
 await page.getByRole('button',{name:'Новая задача',exact:true}).click();
 let modal=page.getByRole('dialog');const title='Browser task '+Date.now();
 await modal.getByLabel('Название',{exact:true}).fill(title);await modal.getByLabel('Описание',{exact:true}).fill('Created by the browser test');
 await modal.getByRole('button',{name:'Создать задачу',exact:true}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Действия: '+title,exact:true}).click();await page.getByRole('button',{name:'Редактировать',exact:true}).click();
 modal=page.getByRole('dialog');await modal.getByLabel('Название',{exact:true}).fill(title+' edited');await modal.getByRole('button',{name:'Сохранить изменения',exact:true}).click();
 await page.getByLabel('Статус: '+title+' edited',{exact:true}).selectOption('done');
 await expect(page.getByLabel('Статус: '+title+' edited',{exact:true})).toHaveValue('done');
 await page.reload();await nav(page,'Задачи');await expect(page.getByRole('heading',{name:title+' edited',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'Поиск задач'}).fill('no-such-unique-task');await expect(page.getByText('Задач по выбранным условиям нет.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();await expect(page.getByRole('heading',{name:title+' edited',exact:true})).toBeVisible();
 await nav(page,'Календарь');await expect(page.getByRole('heading',{name:'Календарь сроков'})).toBeVisible();
 await nav(page,'Команда');await expect(page.getByRole('heading',{name:'Команда',exact:true})).toBeVisible();
 await nav(page,'Обзор');await expect(page.getByText('отредактировал(а) задачу «'+title+' edited»',{exact:false})).toBeVisible();
});
