require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ---------- კონფიგურაცია ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Tbilisi';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('შეცდომა: BOT_TOKEN, SUPABASE_URL ან SUPABASE_SERVICE_KEY არ არის მითითებული.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const awaitingState = {};

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

async function getActiveCompanies() {
  const { data } = await supabase.from('companies').select('id, name').eq('is_active', true).order('name');
  return data || [];
}

function findCompanyByName(companies, name) {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return (
    companies.find((c) => c.name.toLowerCase() === lower) ||
    companies.find((c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())) ||
    null
  );
}

async function interpretMessageWithAI(text, companies) {
  const companyList = companies.map((c) => c.name).join(', ') || '(ჯერ არცერთი კომპანია არ არის)';
  const today = todayStr();

  const systemPrompt =
    `შენ ეხმარები ბუღალტრის ასისტენტ ბოტს ქართული ტექსტის ინტერპრეტაციაში. ` +
    `დღევანდელი თარიღია ${today} (${TIMEZONE}). ` +
    `არსებული აქტიური კომპანიები: ${companyList}. ` +
    `მომხმარებლის შეტყობინება შეიძლება ითხოვდეს ახალი დავალების დამატებას არსებული კომპანიისთვის, ` +
    `ან ახალი კომპანიის დამატებას. თუ თარიღი კონკრეტულად არ არის ნახსენები მაგრამ ცხადია რომ ერთჯერადია, ` +
    `გამოიყენე დღევანდელი თარიღი. თუ მეორდება (ყოველთვის/ყოველკვირეულად/ყოველწლიურად), გამოიყენე შესაბამისი წესი: ` +
    `monthly_day_N, weekly_DAYNAME (ინგლისურად, მაგ weekly_monday), ან yearly_M_D. ` +
    `თუ შეტყობინება არ ითხოვს არცერთს ამათგანს, დააბრუნე action: "none".`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
      tools: [
        {
          name: 'task_action',
          description: 'დაადგინე, რომელი მოქმედება სურს მომხმარებელს.',
          input_schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add_task', 'add_company', 'none'] },
              company_name: { type: 'string' },
              task_title: { type: 'string' },
              due_date: { type: 'string', description: 'YYYY-MM-DD ან ცარიელი სტრიქონი' },
              recurrence_rule: { type: 'string', description: 'monthly_day_N / weekly_დღე / yearly_M_D ან ცარიელი' },
            },
            required: ['action', 'company_name', 'task_title', 'due_date', 'recurrence_rule'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'task_action' },
    }),
  });

  const data = await response.json();
  const toolUse = data.content?.find((block) => block.type === 'tool_use');
  return toolUse ? toolUse.input : { action: 'none' };
}

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
    '/addtask — ახალი დავალების დამატება (ეტაპობრივად)\n\n' +
    (ANTHROPIC_API_KEY
      ? 'ასევე შეგიძლიათ უბრალოდ ჩაწეროთ თხოვნა ჩვეულებრივი ტექსტით, მაგ:\n"დამიმატე ახალი დავალება შპს მზერასთვის 15 რიცხვში"'
      : '')
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

bot.command('deletecompany', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);
  if (!user) return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში.');

  const companies = await getActiveCompanies();

  if (companies.length === 0) {
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

bot.command('addtask', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await getUserByChatId(chatId);
  if (!user) return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში.');

  const companies = await getActiveCompanies();

  if (companies.length === 0) {
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

bot.action('ai_confirm_yes', async (ctx) => {
  const chatId = ctx.chat.id;
  const pending = awaitingState[chatId];

  await ctx.answerCbQuery();

  if (!pending || pending.type !== 'ai_confirm') {
    return ctx.editMessageText('ეს მოთხოვნა უკვე ვადაგასულია.');
  }

  const { action } = pending;

  if (action.kind === 'add_company') {
    await supabase.from('companies').insert({ name: action.company_name });
    delete awaitingState[chatId];
    return ctx.editMessageText(`✅ კომპანია "${action.company_name}" დაემატა.`);
  }

  if (action.kind === 'add_task') {
    const taskData = {
      company_id: action.companyId,
      title: action.task_title,
      is_recurring: !!action.recurrence_rule,
      recurrence_rule: action.recurrence_rule || null,
      due_date: action.recurrence_rule ? null : action.due_date,
    };

    const { data: task, error } = await supabase.from('tasks').insert(taskData).select().single();

    if (error || !task) {
      console.error(error);
      delete awaitingState[chatId];
      return ctx.editMessageText('შეცდომა დავალების დამატებისას.');
    }

    if (!taskData.is_recurring) {
      await supabase.from('task_logs').insert({
        task_id: task.id,
        scheduled_date: taskData.due_date,
        status: 'pending',
      });
    }

    delete awaitingState[chatId];
    return ctx.editMessageText(`✅ დავალება "${action.task_title}" დაემატა.`);
  }
});

bot.action('ai_confirm_no', async (ctx) => {
  const chatId = ctx.chat.id;
  delete awaitingState[chatId];
  await ctx.answerCbQuery();
  await ctx.editMessageText('გაუქმდა.');
});

bot.action(/done_(.+)/, async (ctx) => {
  const taskLogId = ctx.match[1];
  const chatId = ctx.chat.id;

  awaitingState[chatId] = { type: 'note', taskLogId };

  await ctx.answerCbQuery();
  await ctx.reply('დაწერეთ მოკლე კომენტარი, რა გააკეთეთ (ან გამოაგზავნეთ "-" თუ კომენტარი არ გინდათ):');
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = awaitingState[chatId];

  if (state?.type === 'note') {
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

  if (state?.type === 'addtask_title') {
    awaitingState[chatId] = { type: 'addtask_schedule', companyId: state.companyId, title: ctx.message.text };
    return ctx.reply(
      'დაწერეთ თარიღი ერთჯერადი დავალებისთვის ფორმატით YYYY-MM-DD (მაგ. 2026-08-15),\n' +
      'ან თუ განმეორებადია, ჩაწერეთ ერთ-ერთი:\n' +
      '• monthly_day_15 (ყოველთვის 15 რიცხვში)\n' +
      '• weekly_monday (ყოველ ორშაბათს)\n' +
      '• yearly_3_31 (ყოველწლიურად 31 მარტს)'
    );
  }

  if (state?.type === 'addtask_schedule') {
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

  if (!ANTHROPIC_API_KEY) return;

  const user = await getUserByChatId(chatId);
  if (!user) return;

  try {
    const companies = await getActiveCompanies();
    const parsed = await interpretMessageWithAI(ctx.message.text, companies);

    if (parsed.action === 'add_company' && parsed.company_name) {
      awaitingState[chatId] = { type: 'ai_confirm', action: { kind: 'add_company', company_name: parsed.company_name } };
      return ctx.reply(
        `🤖 გავიგე, რომ გსურთ ახალი კომპანიის დამატება:\n\n🏢 ${parsed.company_name}\n\nდავამატო?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ დიახ', 'ai_confirm_yes'),
          Markup.button.callback('❌ არა', 'ai_confirm_no'),
        ])
      );
    }

    if (parsed.action === 'add_task' && parsed.task_title) {
      const company = findCompanyByName(companies, parsed.company_name);

      if (!company) {
        return ctx.reply(
          `🤖 ვერ ვიპოვე კომპანია "${parsed.company_name || 'უცნობი'}". ჯერ დაამატეთ /addcompany-თი, ან დააკონკრეტეთ სახელი.`
        );
      }

      const scheduleText = parsed.recurrence_rule
        ? `განმეორებადი (${parsed.recurrence_rule})`
        : parsed.due_date || todayStr();

      awaitingState[chatId] = {
        type: 'ai_confirm',
        action: {
          kind: 'add_task',
          companyId: company.id,
          task_title: parsed.task_title,
          due_date: parsed.due_date || todayStr(),
          recurrence_rule: parsed.recurrence_rule || null,
        },
      };

      return ctx.reply(
        `🤖 გავიგე, რომ გსურთ დავალების დამატება:\n\n🏢 ${company.name}\n📋 ${parsed.task_title}\n📅 ${scheduleText}\n\nდავამატო?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ დიახ', 'ai_confirm_yes'),
          Markup.button.callback('❌ არა', 'ai_confirm_no'),
        ])
      );
    }
  } catch (e) {
    console.error('AI interpretation error:', e.message);
  }
});

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

cron.schedule(
  '0 8 * * *',
  async () => {
    console.log('ვაწყობთ დღევანდელ დავალებებს და ვგზავნით შემახსენებლებს...');
    await generateRecurringLogs();
    await sendReminders();
  },
  { timezone: TIMEZONE }
);

bot.launch().then(() => console.log('ბოტი გაეშვა წარმატებით.'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
