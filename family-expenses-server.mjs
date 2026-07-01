import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'family-expenses.html');
const dataDir = process.env.DATA_DIR || __dirname;
const dataPath = path.join(dataDir, 'family-expenses-data.json');
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

const defaultCategories = [];
const removedDefaultCategories = ['مديونية', 'سداد مديونية', 'بيت', 'أكل', 'مواصلات', 'مدرسة', 'صحة', 'ترفيه', 'أخرى'];

function defaultData() {
  return {
    passwords: Object.fromEntries(users.map((user) => [user.name, '1234'])),
    goals: Object.fromEntries(users.map((user) => [user.name, { target: 0, saved: 0 }])),
    categories: [...defaultCategories],
    debts: [],
    expenses: []
  };
}

function normalizeGoal(goal) {
  if (goal && typeof goal === 'object') {
    return {
      target: Number(goal.target || goal.amount || 0),
      saved: Number(goal.saved || 0)
    };
  }
  return { target: Number(goal || 0), saved: 0 };
}

function normalizeData(data) {
  const fallbackPassword = data.password || '1234';
  data.passwords = data.passwords || {};
  for (const user of users) {
    data.passwords[user.name] = data.passwords[user.name] || fallbackPassword;
  }
  data.goals = data.goals || {};
  for (const user of users) {
    data.goals[user.name] = normalizeGoal(data.goals[user.name]);
  }
  data.expenses = Array.isArray(data.expenses) ? data.expenses : [];
  data.debts = Array.isArray(data.debts) ? data.debts : [];
  data.categories = [...new Set([
    ...defaultCategories,
    ...(Array.isArray(data.categories) ? data.categories : [])
  ])].filter((category) => category && category !== 'راتب' && !removedDefaultCategories.includes(category));
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
  fs.mkdirSync(dataDir, { recursive: true });
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

function visibleDebts(data, actor) {
  if (actor.admin) return data.debts;
  return data.debts.filter((debt) => debt.person === actor.name);
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
        : { [actor.name]: data.goals[actor.name] || normalizeGoal(0) };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), debts: visibleDebts(data, actor), goals, categories: data.categories });
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

      const type = expense.type === 'salary' ? 'salary' : 'expense';
      const category = type === 'salary'
        ? 'راتب'
        : String(expense.category || '').trim().slice(0, 60);
      if (type !== 'salary' && !category) return sendError(res, 400, 'اكتب التصنيف.');
      if (type !== 'salary' && !data.categories.includes(category)) data.categories.push(category);

      data.expenses.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        person,
        type,
        date: String(expense.date),
        amount,
        category,
        note: String(expense.note || '').slice(0, 300)
      });
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || normalizeGoal(0) };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), debts: visibleDebts(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/api/expenses/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/expenses/', ''));
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');

      const current = data.expenses.find((item) => item.id === id);
      if (!current) return sendError(res, 404, 'العملية غير موجودة.');
      if (!actor.admin && current.person !== actor.name) return sendError(res, 403, 'غير مسموح بالتعديل.');

      const expense = body.expense || {};
      const amount = Number(expense.amount);
      if (!expense.date || !Number.isFinite(amount) || amount <= 0) {
        return sendError(res, 400, 'بيانات العملية غير مكتملة.');
      }

      const person = actor.admin ? expense.person : actor.name;
      if (!getUser(person)) return sendError(res, 400, 'الاسم غير صحيح.');

      const type = expense.type === 'salary' ? 'salary' : 'expense';
      const category = type === 'salary'
        ? 'راتب'
        : String(expense.category || '').trim().slice(0, 60);
      if (type !== 'salary' && !category) return sendError(res, 400, 'اكتب التصنيف.');
      if (type !== 'salary' && !data.categories.includes(category)) data.categories.push(category);

      data.expenses = data.expenses.map((item) => item.id === id ? {
        id,
        person,
        type,
        date: String(expense.date),
        amount,
        category,
        note: String(expense.note || '').slice(0, 300)
      } : item);
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || normalizeGoal(0) };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), debts: visibleDebts(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/expenses/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/expenses/', ''));
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');

      const expense = data.expenses.find((item) => item.id === id);
      if (!expense) return sendError(res, 404, 'المصروف غير موجود.');
      if (!actor.admin && expense.person !== actor.name) return sendError(res, 403, 'غير مسموح بالحذف.');

      data.expenses = data.expenses.filter((item) => item.id !== id);
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || normalizeGoal(0) };
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), debts: visibleDebts(data, actor), goals, categories: data.categories });
    }

    if (req.method === 'POST' && url.pathname === '/api/debts') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');

      const input = body.debt || {};
      const person = actor.admin ? input.person : actor.name;
      const principal = Number(input.principal);
      const installment = Number(input.installment || 0);
      const paid = Number(input.paid || 0);
      const title = String(input.title || '').trim().slice(0, 80);
      if (!getUser(person)) return sendError(res, 400, 'الاسم غير صحيح.');
      if (!title || !Number.isFinite(principal) || principal <= 0) return sendError(res, 400, 'بيانات الدين غير مكتملة.');
      if (!Number.isFinite(installment) || installment < 0 || !Number.isFinite(paid) || paid < 0) return sendError(res, 400, 'مبلغ الدين غير صحيح.');

      data.debts.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        person,
        kind: input.kind === 'sub' ? 'sub' : 'main',
        title,
        principal,
        installment,
        paid: Math.min(paid, principal),
        postponed: 0
      });
      writeData(data);
      return sendJson(res, 200, { debts: visibleDebts(data, actor) });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/debts/') && (url.pathname.endsWith('/pay') || url.pathname.endsWith('/postpone'))) {
      const parts = url.pathname.split('/');
      const action = parts.pop();
      const id = decodeURIComponent(parts.pop());
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');
      const debt = data.debts.find((item) => item.id === id);
      if (!debt) return sendError(res, 404, 'الدين غير موجود.');
      if (!actor.admin && debt.person !== actor.name) return sendError(res, 403, 'غير مسموح.');
      if (action === 'pay') {
        debt.paid = Math.min(Number(debt.principal || 0), Number(debt.paid || 0) + Number(debt.installment || 0));
      } else {
        debt.postponed = Number(debt.postponed || 0) + 1;
      }
      writeData(data);
      return sendJson(res, 200, { debts: visibleDebts(data, actor) });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/debts/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/debts/', ''));
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');
      const debt = data.debts.find((item) => item.id === id);
      if (!debt) return sendError(res, 404, 'الدين غير موجود.');
      if (!actor.admin && debt.person !== actor.name) return sendError(res, 403, 'غير مسموح.');
      data.debts = data.debts.filter((item) => item.id !== id);
      writeData(data);
      return sendJson(res, 200, { debts: visibleDebts(data, actor) });
    }

    if (req.method === 'POST' && url.pathname === '/api/password') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor?.admin) return sendError(res, 403, 'الأب فقط يستطيع تغيير كلمة المرور.');
      const target = getUser(body.targetUser);
      if (!target) return sendError(res, 400, 'الاسم غير صحيح.');
      const nextPassword = String(body.nextPassword || '').trim();
      if (nextPassword.length < 4) {
        return sendError(res, 400, 'كلمة المرور قصيرة.');
      }
      data.passwords[target.name] = nextPassword;
      writeData(data);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/goal') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor) return sendError(res, 401, 'غير مصرح.');
      const requestedTarget = actor.admin ? body.targetUser : actor.name;
      const target = getUser(requestedTarget);
      const amount = Number(body.amount);
      const saved = Number(body.saved || 0);
      if (!target) return sendError(res, 400, 'الاسم غير صحيح.');
      if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(saved) || saved < 0) return sendError(res, 400, 'مبلغ الهدف غير صحيح.');
      data.goals[target.name] = { target: amount, saved };
      writeData(data);
      const goals = actor.admin
        ? data.goals
        : { [actor.name]: data.goals[actor.name] || normalizeGoal(0) };
      return sendJson(res, 200, { goals });
    }

    if (req.method === 'POST' && url.pathname === '/api/clear') {
      const body = await readJson(req);
      const data = readData();
      const actor = authenticate(data, body.user, body.password);
      if (!actor?.admin) return sendError(res, 403, 'الأب فقط يستطيع حذف البيانات.');
      const target = body.targetUser && body.targetUser !== 'all' ? getUser(body.targetUser) : null;
      if (body.targetUser && body.targetUser !== 'all' && !target) return sendError(res, 400, 'الاسم غير صحيح.');
      if (target) {
        data.expenses = data.expenses.filter((item) => item.person !== target.name);
        data.debts = data.debts.filter((item) => item.person !== target.name);
        data.goals[target.name] = normalizeGoal(0);
      } else {
        data.expenses = [];
        data.debts = [];
        data.goals = Object.fromEntries(users.map((user) => [user.name, normalizeGoal(0)]));
      }
      writeData(data);
      return sendJson(res, 200, { expenses: visibleExpenses(data, actor), debts: visibleDebts(data, actor), goals: data.goals, categories: data.categories });
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
