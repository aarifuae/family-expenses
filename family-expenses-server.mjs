import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'family-expenses.html');
const dataPath = path.join(__dirname, 'family-expenses-data.json');
const port = Number(process.env.PORT || 3000);

const users = [
  { name: 'الأب', role: 'الرئيسي', admin: true },
  { name: 'الأم', role: 'عضو' },
  { name: 'عبدالله', role: 'عضو' },
  { name: 'مروان', role: 'عضو' },
  { name: 'عبدالرحمن', role: 'عضو' },
  { name: 'مريم', role: 'عضو' },
  { name: 'المها', role: 'عضو' }
];

const defaultCategories = ['راتب', 'بيت', 'أكل', 'مواصلات', 'مدرسة', 'صحة', 'ترفيه', 'أخرى'];

function defaultData() {
  return {
    passwords: Object.fromEntries(users.map((user) => [user.name, '1234'])),
    goals: Object.fromEntries(users.map((user) => [user.name, 0])),
    categories: [...defaultCategories],
    expenses: []
  };
}

function normalizeData(data) {
  const fallbackPassword = data.password || '1234';
  data.passwords = data.passwords || {};
  for (const user of users) {
    data.passwords[user.name] = data.passwords[user.name] || fallbackPassword;
  }
  data.goals = data.goals || {};
  for (const user of users) {
    data.goals[user.name] = Number(data.goals[user.name] || 0);
  }
  data.expenses = Array.isArray(data.expenses) ? data.expenses : [];
  data.categories = [...new Set([
    ...defaultCategories,
    ...(Array.isArray(data.categories) ? data.categories : []),
    ...data.expenses.map((expense) => expense.category).filter(Boolean)
  ])];
  delete data.password;
  return data;
}

function readData() {
  if (!fs.existsSync(dataPath)) {
    writeData(defaultData());
  }
  try {
    const data = normalizeData(JSON.parse(fs.readFileSync(dataPath, 'utf8')));
    writeData(data);
    return data;
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error) {
  sendJson(res, status, { error });
}

function getUser(name) {
  return users.find((user) => user.name === name);
}

function visibleExpenses(data, actor) {
  if (actor.admin) return data.expenses;
  return data.expenses.filter((expense) => expense.person === actor.name);
}

function authenticate(data, name, password) {
  const actor = getUser(name);
  if (!actor || password !== data.passwords?.[actor.name]) return null;
  return actor;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function localAddresses() {
  const addresses = ['127.0.0.1'];
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records || []) {
      if (record.family === 'IPv4' && !record.internal) {
        addresses.push(record.address);
      }
    }
  }
  return [...new Set(addresses)];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/family-expenses.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'كلمة المرور غير صحيحة.');
      return sendJson(res, 200, { user: actor });
    }

    if (req.method === 'GET' && url.pathname === '/api/expenses') {
      const data = readData();
      const actor = authenticate(data, url.searchParams.get('user'), url.searchParams.get('password'));
      if (!actor) return sendError(res, 401, 'غير مصرح.');
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || 0 };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'POST' && url.pathname === '/api/expenses') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');

      const expense = body.expense || {};
      const amount = Number(expense.amount);
      if (!expense.date || !Number.isFinite(amount) || amount <= 0) {
        return sendError(res, 400, 'بيانات المصروف غير مكتملة.');
      }

      const person = actor.admin ? expense.person : actor.name;
      if (!getUser(person)) return sendError(res, 400, 'الاسم غير صحيح.');

      const category = String(expense.category || 'أخرى').trim().slice(0, 60) || 'أخرى';
      if (!data.categories.includes(category)) data.categories.push(category);

      data.expenses.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        person,
        type: expense.type === 'salary' ? 'salary' : 'expense',
        date: String(expense.date),
        amount,
        category,
        note: String(expense.note || '').slice(0, 300)
      });
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || 0 };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/expenses/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/expenses/', ''));
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');

      const expense = data.expenses.find((item) => item.id === id);
      if (!expense) return sendError(res, 404, 'المصروف غير موجود.');
      if (!actor.admin) return sendError(res, 403, 'الأب فقط يستطيع الحذف.');

      data.expenses = data.expenses.filter((item) => item.id !== id);
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || 0 };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'POST' && url.pathname === '/api/password') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor?.admin) return sendError(res, 403, 'الأب فقط يستطيع تغيير كلمة المرور.');
      const target = getUser(body.targetUser);
      if (!target) return sendError(res, 400, 'الاسم غير صحيح.');
      if (!body.nextPassword || String(body.nextPassword).length < 4) {
        return sendError(res, 400, 'كلمة المرور قصيرة.');
      }
      data.passwords[target.name] = String(body.nextPassword);
      writeData(data);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/goal') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor?.admin) return sendError(res, 403, 'الأب فقط يستطيع تغيير الأهداف.');
      const target = getUser(body.targetUser);
      const amount = Number(body.amount);
      if (!target) return sendError(res, 400, 'الاسم غير صحيح.');
      if (!Number.isFinite(amount) || amount < 0) return sendError(res, 400, 'مبلغ الهدف غير صحيح.');
      data.goals[target.name] = amount;
      writeData(data);
      return sendJson(res, 200, { goals: data.goals });
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor?.admin) return sendError(res, 403, 'الأب فقط يستطيع حذف البيانات.');
      data.expenses = [];
      writeData(data);
      return sendJson(res, 200, { expenses: [] });
    }

    sendError(res, 404, 'Not found');
  } catch (error) {
    sendError(res, 500, error.message || 'Server error');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log('برنامج مصاريف العائلة يعمل الآن:');
  for (const address of localAddresses()) {
    console.log(`http://${address}:${port}`);
  }
  console.log('كلمة المرور الافتراضية: 1234');
});
