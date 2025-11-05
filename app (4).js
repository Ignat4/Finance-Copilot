const $ = (s)=>document.querySelector(s);
const state = { rows:[], summary:null, status:'idle' };
const setStatus = (s, isErr=false)=>{ state.status=s; $("#status span").textContent=s; $("#status span").className = isErr?'bad':'ok'; };

$("#file").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  $("#fileInfo").textContent = file ? `${file.name} • ${(file.size/1024).toFixed(1)} KB` : '';
  if(!file){ $("#analyze").disabled = true; return; }
  try{
    setStatus('parsing');
    const rows = await parseExcel(file);
    const errors = validateRows(rows);
    if(errors.length){
      renderErrors(errors);
      state.rows = [];
      state.summary = null;
      $("#summaryKpis").innerHTML = "";
      $("#summaryInfo").textContent = "Найдены ошибки. Пример первых пяти — ниже.";
      $("#analyze").disabled = true;
      setStatus('error', true);
      return;
    }
    state.rows = rows;
    setStatus('summarizing');
    state.summary = buildSummary(rows);
    renderSummary(state.summary);
    $("#download").disabled = false;
    const token = $("#token").value.trim();
    $("#analyze").disabled = !(state.summary && token.length>0);
    setStatus('idle');
  }catch(err){
    renderErrors([`Ошибка чтения файла: ${err.message||err}`]);
    setStatus('error', true);
  }
});

$("#token").addEventListener("input", ()=>{
  $("#analyze").disabled = !(state.summary && $("#token").value.trim().length>0);
});

$("#download").addEventListener("click", ()=>{
  if(state.summary) downloadJSON(state.summary, "summary.json");
});

$("#analyze").addEventListener("click", async ()=>{
  const token = $("#token").value.trim();
  if(!token || !state.summary) return;
  setStatus('querying');
  $("#advice").textContent = "Запрос к модели...";
  try{
    const prompt = buildPrompt(state.summary, $("#lang").value);
    const text = await callHF(token, prompt);
    $("#advice").textContent = text || "Пустой ответ модели.";
    setStatus('done');
  }catch(err){
    $("#advice").textContent = `Ошибка: ${err.message||err}`;
    setStatus('error', true);
  }
});

async function parseExcel(file){
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type:'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval:null });
  const want = ["Дата","Категория","Описание","Сумма","Тип операции"];
  const rows = json.map(r=>({
    "Дата": r["Дата"],
    "Категория": r["Категория"],
    "Описание": r["Описание"],
    "Сумма": r["Сумма"],
    "Тип операции": r["Тип операции"]
  }));
  const headers = Object.keys(json[0]||{});
  if(!want.every(h=>headers.includes(h))) throw new Error("Отсутствуют обязательные колонки: " + want.join(", "));
  return rows;
}

function validateRows(rows){
  const errs = [];
  const isDate = (s)=>{
    if(typeof s === "number"){
      const d = XLSX.SSF.parse_date_code(s);
      return !!d;
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
  };
  rows.forEach((r,i)=>{
    if(!isDate(r["Дата"])) errs.push(`Строка ${i+2}: неверная дата "${r["Дата"]}"`);
    const amount = Number(r["Сумма"]);
    if(Number.isNaN(amount)) errs.push(`Строка ${i+2}: Сумма не число`);
    const t = r["Тип операции"];
    if(t!=="Доход" && t!=="Расход") errs.push(`Строка ${i+2}: Тип операции должен быть Доход/Расход`);
    if(t==="Доход" && amount<=0) errs.push(`Строка ${i+2}: Доход должен быть > 0`);
    if(t==="Расход" && amount>=0) errs.push(`Строка ${i+2}: Расход должен быть < 0`);
  });
  return errs.slice(0, 50);
}

function buildSummary(rows){
  const parseISO = (s)=>{
    if(typeof s==="number"){ const d=XLSX.SSF.parse_date_code(s); return new Date(d.y, d.m-1, d.d); }
    const [y,m,d]=String(s).split("-").map(Number); return new Date(y,m-1,d);
  };
  const fmt = (d)=>d.toISOString().slice(0,10);
  const monthsSet = new Set();
  let income=0, expenseAbs=0;
  const byCat = new Map();
  const byMonth = new Map();
  const byMerchant = new Map();

  rows.forEach(r=>{
    const dt = parseISO(r["Дата"]);
    const y = dt.getFullYear(), m = String(dt.getMonth()+1).padStart(2,"0");
    monthsSet.add(`${y}-${m}`);
    const amount = Number(r["Сумма"]);
    const cat = String(r["Категория"]||"Прочее").trim();
    const desc = String(r["Описание"]||"").trim()||"(без описания)";
    if(amount>0){ income += amount; }
    else { expenseAbs += Math.abs(amount); }
    if(amount<0){ byCat.set(cat, (byCat.get(cat)||0) + Math.abs(amount)); }
    if(!byMonth.has(`${y}-${m}`)) byMonth.set(`${y}-${m}`, {income:0,expense:0});
    const bm = byMonth.get(`${y}-${m}`);
    if(amount>0) bm.income += amount; else bm.expense += Math.abs(amount);
    if(amount<0){
      const mObj = byMerchant.get(desc) || {transactions:0, expense:0, days:[]};
      mObj.transactions++; mObj.expense += Math.abs(amount); mObj.days.push(dt.getDate());
      byMerchant.set(desc, mObj);
    }
  });

  const months = Array.from(monthsSet).sort();
  const firstDate = rows.map(r=>parseISO(r["Дата"])).sort((a,b)=>a-b)[0];
  const lastDate  = rows.map(r=>parseISO(r["Дата"])).sort((a,b)=>b-a)[0];
  const byCategory = Array.from(byCat.entries()).map(([category, expense])=>({category, expense})).sort((a,b)=>b.expense-a.expense);
  const monthly = months.map(m=>({month:m, income:Math.round((byMonth.get(m)?.income||0)*100)/100, expense:Math.round((byMonth.get(m)?.expense||0)*100)/100, net:Math.round(((byMonth.get(m)?.income||0)-(byMonth.get(m)?.expense||0))*100)/100 }));

  const expVals = monthly.map(x=>x.expense);
  const expAvg = expVals.length? expVals.reduce((a,b)=>a+b,0)/expVals.length : 0;
  const expVar = expVals.length? expVals.reduce((a,b)=>a+(b-expAvg)**2,0)/expVals.length : 0;
  const expenseVolatility = Math.sqrt(expVar);

  const topMerchants = Array.from(byMerchant.entries())
    .map(([name,v])=>({name, transactions:v.transactions, expense:Math.round(v.expense*100)/100, days:v.days}))
    .sort((a,b)=>b.expense-a.expense).slice(0,5);

  const recurringPayments = Array.from(byMerchant.entries())
    .map(([name,v])=>{
      const days=v.days.sort((a,b)=>a-b);
      const md = days.length? Math.round(days.reduce((a,b)=>a+b,0)/days.length): null;
      const mean = v.expense / (v.transactions||1);
      const variance = days.length? days.reduce((a,b)=>a+(b-md)**2,0)/days.length : 0;
      const std = Math.sqrt(variance);
      return {name, avg:Math.round(mean*100)/100, std:Math.round(std*100)/100, monthDayHint: md||null, count:v.transactions};
    })
    .filter(x=>x.count>=2)
    .sort((a,b)=>b.avg-a.avg)
    .slice(0,5)
    .map(({name,avg,std,monthDayHint})=>({name,avg, std, monthDayHint}));

  return {
    period:{ from: fmt(firstDate), to: fmt(lastDate), months },
    totals:{ income: round2(income), expense: round2(expenseAbs), net: round2(income-expenseAbs) },
    byCategory,
    monthly,
    topMerchants,
    riskSignals:{
      savingsRate: income? round4((income-expenseAbs)/income) : 0,
      expenseVolatility: round2(expenseVolatility),
      recurringPayments
    }
  };
}

function round2(x){ return Math.round(x*100)/100 }
function round4(x){ return Math.round(x*10000)/10000 }

function renderSummary(sum){
  $("#errors").innerHTML = "";
  $("#summaryInfo").textContent = `Период: ${sum.period.from} — ${sum.period.to} • Месяцев: ${sum.period.months.length}`;
  $("#summaryKpis").innerHTML = [
    kpi("Доходы", sum.totals.income.toLocaleString("ru-RU")+" ₽"),
    kpi("Расходы", sum.totals.expense.toLocaleString("ru-RU")+" ₽"),
    kpi("Баланс", sum.totals.net.toLocaleString("ru-RU")+" ₽"),
  ].join("");
  const top3 = sum.byCategory.slice(0,3);
  const totExp = sum.totals.expense || 1;
  const line = top3.map(x=>`${x.category}: ${(x.expense*100/totExp).toFixed(1)}%`).join(" • ");
  $("#topCats").textContent = top3.length ? `Топ-3 категории расходов: ${line}` : "";
}

function kpi(title, val){ return `<div class="kpi"><label>${title}</label><b>${val}</b></div>` }

function renderErrors(errs){
  $("#errors").innerHTML = `<div class="err"><span class="bad">Ошибки:</span><ul class="errlist">${errs.slice(0,5).map(e=>`<li>${e}</li>`).join("")}</ul></div>`;
}

function buildPrompt(summary, lang){
  const json = JSON.stringify(summary);
  if(lang==="EN"){
    return `You are a personal finance coach. Based on the transaction summary, provide 1–3 actionable, specific recommendations the user can do this week. Do not repeat the input data. Max 120 words.\nSummary:\n${json}`;
  } else {
    return `Ты — финансовый советник. На основе сводки транзакций дай 1–3 персональные рекомендации, конкретные и выполнимые на этой неделе. Не повторяй входные данные. Максимум 120 слов.\nСводка:\n${json}`;
  }
}

async function callHF(token, prompt){
  const res = await fetch("https://api-inference.huggingface.co/models/tiiuae/falcon-7b-instruct", {
    method:"POST",
    headers:{
      "Authorization":"Bearer " + token,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ inputs: prompt })
  });
  if(res.status===401) throw new Error("401: проверьте Hugging Face токен.");
  if(res.status===429) throw new Error("429: превышен лимит запросов, попробуйте позже.");
  if(res.status===503) throw new Error("503: модель прогревается, повторите запрос через минуту.");
  if(!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const data = await res.json();
  if(Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
  if(typeof data === "string") return data;
  const t = data?.generated_text || data?.[0]?.generated_text || JSON.stringify(data);
  return String(t);
}

function downloadJSON(obj, filename){
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
