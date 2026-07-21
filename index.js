require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ---------- კონფიგურაცია (მოდის Railway-ს environment variables-იდან) ----------
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

// დროებითი მეხსიერება: ველოდებით თუ არა კომენტარს კონკრეტული chat_id-სგან
// { [chatId]: taskLogId }
const awaitingNote = {};

// ---------- დამხმარე ფუნქციები ----------

function todayStr() {
  // YYYY-MM-DD ფორმატში, სწორი დროის სარტყლით
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function weekdayName(date) {
  return date.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long' }).toLowerCase();
}

// ამოწმებს ემთხვევა თუ არა დღევანდელი თარიღი task-ის განმეორების წესს
function matchesRecurrence(rule, date) {
  if (!rule) return false;
  const day = date.getDate();
  const month = date.getMonth() + 1;

  if (rule.startsWith('monthly_day_')) {
    const targetDay = parseInt(rule.replace('monthly_day_', ''), 10);
    return day === targetDay;
  }
  if (rule.startsWith('weekly_')) {
    const targetDay = rule.replace('weekly_', '');
    return weekdayName(date) === targetDay;
  }
  if (rule.startsWith('yearly_')) {
    const [, mm, dd] = rule.split('_');
    return month === parseInt(mm, 10) && day === parseInt(dd, 10);
  }
  return false;
}

// ---------- ბრძანებები ----------

bot.start((ctx) => {
  ctx.reply(
    `გამარჯობა! თქვენი Telegram Chat ID არის:\n\n${ctx.chat.id}\n\n` +
    `გთხოვთ, გაუგზავნოთ ეს ID სისტემის ადმინისტრატორს, რომ დაგამატოთ users ცხრილში.`
  );
});

bot.command('tasks', async (ctx) => {
  const chatId = String(ctx.chat.id);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, full_name')
    .eq('telegram_chat_id', chatId)
    .single();

  console.log('DEBUG chatId:', JSON.stringify(chatId));
  console.log('DEBUG user:', JSON.stringify(user));
  console.log('DEBUG error:', JSON.stringify(userError));

  if (!user) {
    return ctx.reply('თქვენ ჯერ არ ხართ დარეგისტრირებული სისტემაში. მიმართეთ ადმინისტრატორს.');
  }

  const today = todayStr();

  const { data: logs, error } = await supabase
    .from('task_logs')
    .select('id, status, tasks(title, description, companies(name))')
    .eq('scheduled_date', today)
    .neq('status', 'done');

  if (error) {
    console.error(error);
    return ctx.reply('ბაზასთან დაკავშირების შეცდომა.');
  }

  const myLogs = (logs || []).filter((l) => l.tasks); // simple filter, assignment checked below if needed

  if (myLogs.length === 0) {
    return ctx.reply('დღეს დავალებები არ გაქვთ. 🎉');
  }

  for (const log of myLogs) {
    const companyName = log.tasks?.companies?.name || 'უცნობი კომპანია';
    const title = log.tasks?.title || '';
    await ctx.reply(
      `🏢 ${companyName}\n📋 ${title}`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ დასრულებულია', `done_${log.id}`),
      ])
    );
  }
});

// ღილაკზე დაჭერა -> ვითხოვთ კომენტარს
bot.action(/done_(.+)/, async (ctx) => {
  const taskLogId = ctx.match[1];
  const chatId = ctx.chat.id;

  awaitingNote[chatId] = taskLogId;

  await ctx.answerCbQuery();
  await ctx.reply('დაწერეთ მოკლე კომენტარი, რა გააკეთეთ (ან გამოაგზავნეთ "-" თუ კომენტარი არ გინდათ):');
});

// ტექსტური შეტყობინება -> თუ ველოდებით კომენტარს, ვინახავთ
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const taskLogId = awaitingNote[chatId];

  if (!taskLogId) return; // ჩვეულებრივი შეტყობინება, არაფერი გვჭირდება

  const note = ctx.message.text === '-' ? null : ctx.message.text;

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_chat_id', String(chatId))
    .single();

  await supabase
    .from('task_logs')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      completed_by: user?.id || null,
      completion_note: note,
    })
    .eq('id', taskLogId);

  delete awaitingNote[chatId];
  await ctx.reply('✅ მონიშნულია, როგორც დასრულებული. კარგი საქმეა!');
});

// ---------- ავტომატური ფონური სამუშაოები ----------

// 1. განმეორებადი დავალებებისთვის დღევანდელი ჩანაწერების შექმნა
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

    // შევამოწმოთ უკვე ხომ არ არსებობს დღევანდელი ჩანაწერი
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

// 2. დღევანდელი დავალებების შემახსენებლების გაგზავნა
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
        Markup.inlineKeyboard([
          Markup.button.callback('✅ დასრულებულია', `done_${log.id}`),
        ])
      );

      await supabase
        .from('task_logs')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', log.id);
    } catch (e) {
      console.error(`ვერ გაიგზავნა შეტყობინება chat_id ${chatId}-ზე:`, e.message);
    }
  }
}

// ყოველდღე დილის 08:00-ზე (თბილისის დროით)
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
