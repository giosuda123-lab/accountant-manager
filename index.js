require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ---------- კონფიგურაცია ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Tbilisi';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('შეცდომა: BOT_TOKEN, SUPABASE_URL ან SUPABASE_SERVICE_KEY არ არის მითითებული.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// დროებითი მეხსიერება ეტაპობრივი დიალოგებისთვის (chatId -> state)
const awaitingState = {};

// ---------- დამხმარე ფუნქციები ----------

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function weekdayName(date) {
  return date.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long' }).toLowerCase();
}

function matchesRecurrence(rule, date) {
  if (!rule) return false;
  const day = date.getDate();
  const month = date.getMonth() + 1;

  if (rule.startsWith('monthly_day_')) {
    return day === parseInt(rule.replace('monthly_day_', ''), 10);
  }
  if (rule.startsWith('weekly_')) {
    return weekdayName(date) === rule.replace('weekly_', '');
  }
  if (rule.startsWith('yearly_')) {
    const [, mm, dd] = rule.split('_');
    return month === parseInt(mm, 10) && day === parseInt(dd, 10);
  }
  return false;
}

function isValidRecurrenceRule(rule) {
  return /^monthly_day_([1-9]|[12][0-9]|3[01])$/.test(rule) ||
    /^weekly_(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(rule) ||
    /^yearly_(1[0-2]|[1-9])_([1-9]|[12][0-9]|3[01])$/.test(rule);
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str).getTime());
}

async function getUserByChatId(chatId) {
  const { data } = await supabase
    .from('users')
    .select('id, full_name, role')
    .eq('telegram_chat_id', String(chatId))
    .single();
  return data;
}

// ---------- ძირითადი ბრძანებები ----------

bot.start((ctx) => {
  ctx.reply(
    `გამარჯობა! თქვენი Telegram Chat ID არის:\n\n${ctx.chat.id}\n\n` +
    `გთხოვთ, გაუგზავნოთ ეს ID სისტემის ადმინისტრატორს, რომ დაგამატოთ users ცხრილში.`
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    'ხელმისაწვდომი ბრძანებები:\n\n' +
    '/tasks — დღევანდელი დავალებები\n' +
    '/addcompany [სახელი] — ახალი კომპანიის დამატება\n' +
    '/deletecompany — კომპანიის წაშლა\n' +
    '/addtask — ახალი დავალების დამატება (ეტაპობრივად)'
  );
});

bot.command('tasks', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);

  if (!user) {
    return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში. მიმართეთ ადმინისტრატორს.');
  }

  const today = todayStr();

  const { data: logs, error } = await supabase
    .from('task_logs')
    .select('id, status, tasks(title, companies(name))')
    .eq('scheduled_date', today)
    .neq('status', 'done');

  if (error) {
    console.error(error);
    return ctx.reply('ბაზასთან დაკავშირების შეცდომა.');
  }

  const myLogs = (logs || []).filter((l) => l.tasks);

  if (myLogs.length === 0) {
    return ctx.reply('დღეს დავალებები არ გაქვთ. 🎉');
  }

  for (const log of myLogs) {
    const companyName = log.tasks?.companies?.name || 'უცნობი კომპანია';
    const title = log.tasks?.title || '';
    await ctx.reply(
      `🏢 ${companyName}\n📋 ${title}`,
      Markup.inlineKeyboard([Markup.button.callback('✅ დასრულებულია', `done_${log.id}`)])
    );
  }
});

// ---------- კომპანიის დამატება ----------

bot.command('addcompany', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);
  if (!user) return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში.');

  const name = ctx.message.text.replace('/addcompany', '').trim();

  if (!name) {
    return ctx.reply('გთხოვთ, ბრძანების შემდეგ ჩაწეროთ კომპანიის სახელი. მაგალითი:\n/addcompany შპს მზერა');
  }

  const { error } = await supabase.from('companies').insert({ name });

  if (error) {
    console.error(error);
    return ctx.reply('შეცდომა კომპანიის დამატებისას.');
  }

  ctx.reply(`✅ კომპანია "${name}" დაემატა.`);
});

// ---------- კომპანიის წაშლა ----------

bot.command('deletecompany', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);
  if (!user) return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში.');

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name')
    .eq('is_active', true)
    .order('name');

  if (error || !companies || companies.length === 0) {
    return ctx.reply('აქტიური კომპანია არ მოიძებნა.');
  }

  const buttons = companies.map((c) => [Markup.button.callback(c.name, `delcompany_${c.id}`)]);
  ctx.reply('რომელი კომპანია გსურთ წაშალოთ?', Markup.inlineKeyboard(buttons));
});

bot.action(/delcompany_(.+)/, async (ctx) => {
  const companyId = ctx.match[1];

  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).single();

  await ctx.answerCbQuery();
  await ctx.reply(
    `დარწმუნებული ხართ, რომ გსურთ წაშალოთ "${company?.name || 'ეს კომპანია'}"? ეს დამალავს კომპანიას და მის ყველა დავალებას.`,
    Markup.inlineKeyboard([
      Markup.button.callback('✅ დიახ, წაშალე', `delcompany_confirm_${companyId}`),
      Markup.button.callback('❌ გაუქმება', 'delcompany_cancel'),
    ])
  );
});

bot.action(/delcompany_confirm_(.+)/, async (ctx) => {
  const companyId = ctx.match[1];

  await supabase.from('companies').update({ is_active: false }).eq('id', companyId);
  await supabase.from('tasks').update({ is_archived: true }).eq('company_id', companyId);

  await ctx.answerCbQuery();
  await ctx.editMessageText('🗑 კომპანია წაშლილია.');
});

bot.action('delcompany_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('გაუქმდა.');
});

// ---------- დავალების დამატება (ეტაპობრივი დიალოგი) ----------

bot.command('addtask', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);
  if (!user) return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში.');

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name')
    .eq('is_active', true)
    .order('name');

  if (error || !companies || companies.length === 0) {
    return ctx.reply('ჯერ არცერთი კომპანია არ გაქვთ დამატებული. ჯერ გამოიყენეთ /addcompany.');
  }

  const buttons = companies.map((c) => [Markup.button.callback(c.name, `addtask_company_${c.id}`)]);
  ctx.reply('რომელი კომპანიისთვის გსურთ დავალების დამატება?', Markup.inlineKeyboard(buttons));
});

bot.action(/addtask_company_(.+)/, async (ctx) => {
  const companyId = ctx.match[1];
  const chatId = ctx.chat.id;

  awaitingState[chatId] = { type: 'addtask_title', companyId };

  await ctx.answerCbQuery();
  await ctx.reply('დაწერეთ დავალების დასახელება:');
});

// ---------- ტექსტური შეტყობინებების დამუშავება ----------

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = awaitingState[chatId];

  if (!state) return; // ჩვეულებრივი შეტყობინება, კონტექსტი არ გვაქვს

  // --- დასრულების კომენტარის ლოდინი ---
  if (state.type === 'note') {
    const note = ctx.message.text === '-' ? null : ctx.message.text;

    const user = await getUserByChatId(chatId);

    await supabase
      .from('task_logs')
      .update({
        status: 'done',
        completed_at: new Date().toISOString(),
        completed_by: user?.id || null,
        completion_note: note,
      })
      .eq('id', state.taskLogId);

    delete awaitingState[chatId];
    return ctx.reply('✅ მონიშნულია, როგორც დასრულებული. კარგი საქმეა!');
  }

  // --- ახალი დავალების სახელის ლოდინი ---
  if (state.type === 'addtask_title') {
    awaitingState[chatId] = { type: 'addtask_schedule', companyId: state.companyId, title: ctx.message.text };
    return ctx.reply(
      'დაწერეთ თარიღი ერთჯერადი დავალებისთვის ფორმატით YYYY-MM-DD (მაგ. 2026-08-15),\n' +
      'ან თუ განმეორებადია, ჩაწერეთ ერთ-ერთი:\n' +
      '• monthly_day_15 (ყოველთვის 15 რიცხვში)\n' +
      '• weekly_monday (ყოველ ორშაბათს)\n' +
      '• yearly_3_31 (ყოველწლიურად 31 მარტს)'
    );
  }

  // --- თარიღის/წესის ლოდინი ---
  if (state.type === 'addtask_schedule') {
    const input = ctx.message.text.trim();
    const { companyId, title } = state;

    let taskData;
    if (isValidDate(input)) {
      taskData = { company_id: companyId, title, is_recurring: false, due_date: input };
    } else if (isValidRecurrenceRule(input)) {
      taskData = { company_id: companyId, title, is_recurring: true, recurrence_rule: input };
    } else {
      return ctx.reply('ფორმატი ვერ ამოვიცანი. სცადეთ თავიდან, ზუსტად ისე, როგორც მაგალითში მოცემულია.');
    }

    const { data: task, error } = await supabase.from('tasks').insert(taskData).select().single();

    if (error || !task) {
      console.error(error);
      delete awaitingState[chatId];
      return ctx.reply('შეცდომა დავალების დამატებისას.');
    }

    if (!taskData.is_recurring) {
      await supabase.from('task_logs').insert({
        task_id: task.id,
        scheduled_date: taskData.due_date,
        status: 'pending',
      });
    }

    delete awaitingState[chatId];
    return ctx.reply(`✅ დავალება "${title}" დაემატა.`);
  }
});

// ---------- ავტომატური ფონური სამუშაოები ----------

async function generateRecurringLogs() {
  const today = new Date();
  const todayDate = todayStr();

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, recurrence_rule')
    .eq('is_recurring', true)
    .eq('is_archived', false);

  if (error) {
    console.error('generateRecurringLogs error:', error);
    return;
  }

  for (const task of tasks || []) {
    if (!matchesRecurrence(task.recurrence_rule, today)) continue;

    const { data: existing } = await supabase
      .from('task_logs')
      .select('id')
      .eq('task_id', task.id)
      .eq('scheduled_date', todayDate)
      .maybeSingle();

    if (!existing) {
      await supabase.from('task_logs').insert({
        task_id: task.id,
        scheduled_date: todayDate,
        status: 'pending',
      });
      console.log(`შეიქმნა ახალი log: task ${task.id}, თარიღი ${todayDate}`);
    }
  }
}

async function sendReminders() {
  const todayDate = todayStr();

  const { data: logs, error } = await supabase
    .from('task_logs')
    .select('id, tasks(title, assigned_to, companies(name), users:assigned_to(telegram_chat_id))')
    .eq('scheduled_date', todayDate)
    .eq('status', 'pending')
    .is('reminder_sent_at', null);

  if (error) {
    console.error('sendReminders error:', error);
    return;
  }

  for (const log of logs || []) {
    const chatId = log.tasks?.users?.telegram_chat_id;
    if (!chatId) continue;

    const companyName = log.tasks?.companies?.name || 'უცნობი კომპანია';
    const title = log.tasks?.title || '';

    try {
      await bot.telegram.sendMessage(
        chatId,
        `🔔 შეხსენება!\n\n🏢 ${companyName}\n📋 ${title}`,
        Markup.inlineKeyboard([Markup.button.callback('✅ დასრულებულია', `done_${log.id}`)])
      );

      await supabase.from('task_logs').update({ reminder_sent_at: new Date().toISOString() }).eq('id', log.id);
    } catch (e) {
      console.error(`ვერ გაიგზავნა შეტყობინება chat_id ${chatId}-ზე:`, e.message);
    }
  }
}

bot.action(/done_(.+)/, async (ctx) => {
  const taskLogId = ctx.match[1];
  const chatId = ctx.chat.id;

  awaitingState[chatId] = { type: 'note', taskLogId };

  await ctx.answerCbQuery();
  await ctx.reply('დაწერეთ მოკლე კომენტარი, რა გააკეთეთ (ან გამოაგზავნეთ "-" თუ კომენტარი არ გინდათ):');
});

cron.schedule(
  '0 8 * * *',
  async () => {
    console.log('ვაწყობთ დღევანდელ დავალებებს და ვგზავნით შემახსენებლებს...');
    await generateRecurringLogs();
    await sendReminders();
  },
  { timezone: TIMEZONE }
);

// ---------- გაშვება ----------
bot.launch().then(() => console.log('ბოტი გაეშვა წარმატებით.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
