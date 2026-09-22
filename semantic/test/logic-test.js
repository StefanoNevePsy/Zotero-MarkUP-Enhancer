const fs=require('fs'),vm=require('vm');
const prefs={};
const ctx={ZoteroSemantic:{log:()=>{}},Zotero:{Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v}},console};
vm.createContext(ctx);
for (const f of ['src/utils.js','src/similarity.js','src/providers.js','src/search.js','src/store.js','src/concepts.js'].map(p=>__dirname+'/../'+p)) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const U=ctx.ZoteroSemantic.Utils, S=ctx.ZoteroSemantic.Similarity, P=ctx.ZoteroSemantic.Providers, SE=ctx.ZoteroSemantic.Search;
const ST=ctx.ZoteroSemantic.Store, CO=ctx.ZoteroSemantic.Concepts;
U.ensureDefaultPrefs();
let pass=0,fail=0;
const chk=(n,c)=>{ c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n)); };

console.log('-- campionamento di un "libro" (600k caratteri) --');
const book='x'.repeat(600000);
const s=U.sample(book,6,500);
chk('6 estratti', s.length===6);
chk('totale ~3000 char, non 600k', s.join('').length===3000);

console.log('-- spread: copre tutto l\'arco, non solo l\'inizio --');
const arr=Array.from({length:100},(_,i)=>i);
const sp=U.spread(arr,5);
chk('5 elementi', sp.length===5);
chk('parte da 0 e arriva in fondo', sp[0]===0 && sp[4]>=80);
chk('array corto restituito intero', U.spread([1,2],5).length===2);

console.log('-- parsing risposta modello --');
chk('array puro', JSON.stringify(U.parseJSONLoose('["a","b"]'))==='["a","b"]');
chk('dentro code fence', JSON.stringify(U.parseJSONLoose('```json\n["a"]\n```'))==='["a"]');
chk('con prosa attorno', JSON.stringify(U.parseJSONLoose('Ecco i tag: ["a","b"] spero vada bene'))==='["a","b"]');
chk('spazzatura -> null', U.parseJSONLoose('boh')===null);

console.log('-- similarita lessicale --');
const mk=(t,c,co)=>({tags:new Set(t),creators:new Set(c),cols:new Set(co)});
const a=mk(['terapia','mito'],['palazzoli'],[1]);
const b=mk(['terapia','mito'],['palazzoli'],[1]);
const c=mk(['emdr'],['shapiro'],[2]);
chk('identici -> 1', Math.abs(S.lexicalScore(a,b)-1)<1e-9);
chk('disgiunti -> 0', S.lexicalScore(a,c)===0);
chk('parziale sta in mezzo', (()=>{const x=S.lexicalScore(a,mk(['terapia'],['x'],[9]));return x>0&&x<1;})());

console.log('-- rescale del coseno (evita "tutto correlato") --');
chk('0.5 -> 0', S.rescale(0.5)===0);
chk('0.95 -> 1', S.rescale(0.95)===1);
chk('monotono crescente', S.rescale(0.7)<S.rescale(0.85));
chk('coseno identico = 1', U.cosine([1,2,3],[1,2,3])>0.999);
chk('coseno ortogonale = 0', Math.abs(U.cosine([1,0],[0,1]))<1e-9);

console.log('-- normalizzazione risposta tag (array o oggetto da --schema) --');
chk('array semplice', JSON.stringify(P.normalizeTags(['a','b']))==='["a","b"]');
chk('oggetto {tags:[...]} di fm --schema', JSON.stringify(P.normalizeTags({tags:['a','b']}))==='["a","b"]');
chk('oggetto con altro nome di campo', JSON.stringify(P.normalizeTags({items:['x']}))==='["x"]');
chk('null -> vuoto', JSON.stringify(P.normalizeTags(null))==='[]');
chk('oggetto senza array -> vuoto', JSON.stringify(P.normalizeTags({a:1}))==='[]');

console.log('-- costruzione comando fm (due occorrenze di {cli}) --');
const tpl=U.DEFAULTS.appleTemplate;
const cmd=P.Apple.buildCommand(tpl,'/usr/bin/fm',{prompt:'/tmp/p.txt',schema:'/tmp/s.json',out:'/tmp/o.txt'});
chk('nessun segnaposto residuo', !/\{(cli|prompt|schema|out)\}/.test(cmd));
chk('entrambe le occorrenze di {cli} sostituite', (cmd.match(/\/usr\/bin\/fm/g)||[]).length===2);
chk('genera lo schema prima di rispondere', cmd.indexOf('schema object')<cmd.indexOf('respond'));
chk('passa --schema a respond', cmd.includes("--schema '/tmp/s.json'"));
chk('redirige su file di output', cmd.includes("> '/tmp/o.txt'"));
const plain=P.Apple.buildCommand(U.DEFAULTS.appleTemplatePlain,'/opt/fmx',{prompt:'/tmp/p',schema:'/tmp/s',out:'/tmp/o'});
chk('fallback senza --schema', !plain.includes('--schema'));

console.log('-- campionamento a budget del testo del documento --');
// Un libro lungo deve stare nel budget ma essere rappresentato dall'inizio
// alla fine, non solo dal primo capitolo.
const libro='INIZIO'+'a'.repeat(300000)+'META'+'b'.repeat(300000)+'FINE';
const exc=U.sampleWithinBudget(libro,3000);
chk('rispetta il budget', exc.length<=3000);
chk('non e vuoto', exc.length>1000);
chk('include l\'inizio del documento', exc.startsWith('INIZIO'));
chk('arriva fino alla fine', exc.includes('FINE'));
chk('testo corto restituito integralmente', U.sampleWithinBudget('breve',3000)==='breve');
chk('testo assente -> stringa vuota', U.sampleWithinBudget('',3000)==='');
chk('budget piccolo comunque rispettato', U.sampleWithinBudget(libro,500).length<=500);

console.log('-- ranking per pertinenza a un argomento --');
// La query "e' vicina" al vettore 0 e lontana dal 2.
const q=[1,0,0];
const vecs=[[0.9,0.1,0],[0.5,0.5,0],[0,0,1]];
const rk=SE.rankByVector(q,vecs);
chk('tutti i documenti classificati', rk.length===3);
chk('ordinamento decrescente', rk[0].score>=rk[1].score && rk[1].score>=rk[2].score);
chk('il piu pertinente e il primo', rk[0].i===0);
chk('il meno pertinente e l\'ultimo', rk[2].i===2);
chk('punteggi nell\'intervallo atteso', rk.every(r=>r.score>=-1.001&&r.score<=1.001));
const conBuchi=SE.rankByVector(q,[[1,0,0],null,[0,1,0]]);
chk('i documenti senza vettore sono esclusi', conBuchi.length===2);
chk('nessun indice non valido', conBuchi.every(r=>r.i!==1));

console.log('-- embedding: asimmetria query/passaggio e separazione dei motori --');
// NVIDIA avverte che sbagliare input_type causa "large drops in retrieval
// accuracy": il documento va indicizzato come "passage", la ricerca come "query".
const bodyDoc=P.Nvidia.buildBody('testo','passage','nvidia/nemotron-3-embed-1b');
const bodyQry=P.Nvidia.buildBody('testo','query','nvidia/nemotron-3-embed-1b');
chk('documento indicizzato come passage', bodyDoc.input_type==='passage');
chk('ricerca inviata come query', bodyQry.input_type==='query');
chk('kind sconosciuto ricade su passage', P.Nvidia.buildBody('t',undefined,'m').input_type==='passage');
chk('testo incapsulato in un array', Array.isArray(bodyDoc.input) && bodyDoc.input[0]==='testo');
chk('modello passato al servizio', bodyDoc.model==='nvidia/nemotron-3-embed-1b');
chk('troncamento lato servizio invece del rifiuto', bodyDoc.truncate==='END');

// La firma entra nella chiave di cache: vettori di modelli diversi vivono in
// spazi diversi e non vanno mai confrontati fra loro.
U.set('embedProvider','gemini');
const sigGemini=P.embedSignature();
chk('con Gemini gli embedding usano Gemini', P.embedProvider()===P.Gemini);
U.set('embedProvider','nvidia');
const sigNvidia=P.embedSignature();
chk('con NVIDIA gli embedding usano NVIDIA', P.embedProvider()===P.Nvidia);
chk('la firma cambia cambiando motore', sigGemini!==sigNvidia);
U.set('nvidiaEmbedModel','nvidia/altro-modello');
chk('la firma cambia cambiando modello', P.embedSignature()!==sigNvidia);

// Il motore dei tag e quello degli embedding sono indipendenti: con Apple per i
// tag il grafo deve continuare a funzionare.
U.set('provider','apple');
U.set('nvidiaKey','chiave-finta');
chk('tagging Apple + embedding NVIDIA convivono', P.name()==='apple' && P.embedProviderName()==='nvidia');
chk('gli embedding sono disponibili con la key NVIDIA', P.supportsEmbeddings()===true);
U.set('nvidiaKey','');
chk('senza key NVIDIA gli embedding sono disattivati', P.supportsEmbeddings()===false);
U.set('embedProvider','gemini'); U.set('provider','gemini');
U.set('nvidiaEmbedModel',U.DEFAULTS.nvidiaEmbedModel);

console.log('-- preferenze: Mozilla accetta solo string/bool/intero a 32 bit --');
// Un valore frazionario faceva lanciare Zotero.Prefs.set, uccidendo init()
// prima che venisse registrata qualsiasi UI. Qui non deve piu' passare.
const badPrefs=Object.entries(U.DEFAULTS).filter(([k,v])=>{
  if (typeof v==='string'||typeof v==='boolean') return false;
  if (typeof v==='number') return !Number.isInteger(v) || Math.abs(v)>2147483647;
  return true;
});
chk('nessuna preferenza con valore non ammesso'+(badPrefs.length?' -> '+JSON.stringify(badPrefs):''), badPrefs.length===0);
chk('graphMinWeightPct e intero', Number.isInteger(U.DEFAULTS.graphMinWeightPct));
chk('la soglia resta 0.12 dopo la divisione', U.DEFAULTS.graphMinWeightPct/100===0.12);

console.log('-- righe della finestra dei risultati --');
const mkItem=(id,title,last,date,tags)=>({id,getField:f=>f==='title'?title:(f==='date'?date:''),
  getCreators:()=>last?[{lastName:last}]:[],getTags:()=>tags.map(t=>({tag:t}))});
const searchItems=[mkItem(1,'Il mito della famiglia','Rossi','2019',['omeostasi']),
                   mkItem(2,'','Bianchi','',[])];
const rows=SE.toRows(searchItems,[{i:1,score:0.8},{i:0,score:0.9}]);
chk('una riga per risultato, nell\'ordine del ranking', rows.length===2 && rows[0].id===2);
chk('titolo mancante sostituito', rows[0].title==='(senza titolo)');
chk('id dell\'elemento conservato per il doppio clic', rows[1].id===1);
chk('metadati compilati', rows[1].meta.includes('Rossi') && rows[1].meta.includes('2019'));
chk('nessun oggetto Zotero nelle righe', rows.every(r=>typeof r.getField==='undefined'));

console.log('-- dimensione del buffer del canvas --');
// "Canvas exceeds max size" blocca il contesto 2D in modo permanente: il buffer
// non deve mai superare il budget, per quanto grande sia la finestra.
const gctx={console};
vm.createContext(gctx);
vm.runInContext(fs.readFileSync(__dirname+'/../content/graph.js','utf8'),gctx);
const graphSrc=fs.readFileSync(__dirname+'/../content/graph.js','utf8');
// Le dichiarazioni const non diventano proprieta del contesto: il budget si
// legge dal sorgente, cosi il test resta legato ai valori veri.
const bs=gctx.backingScale;
const MS=Number((graphSrc.match(/MAX_SIDE\s*=\s*([\d.e]+)/)||[])[1]);
const MP=Number((graphSrc.match(/MAX_PIXELS\s*=\s*([\d.e]+)/)||[])[1]);
chk('budget letto dal sorgente', Number.isFinite(MS) && Number.isFinite(MP));
const within=(w,h,d)=>{const s=bs(w,h,d);return w*s<=MS+1 && h*s<=MS+1 && w*h*s*s<=MP*1.001;};
chk('finestra normale: usa il device pixel ratio', bs(1100,720,2)===2);
chk('schermo non retina: scala 1', bs(1100,720,1)===1);
chk('finestra enorme: resta nel budget', within(20000,12000,2));
chk('lato estremo: resta nel budget', within(60000,300,2));
chk('dpr assurdo: resta nel budget', within(1400,900,40));
chk('scala mai nulla o negativa', bs(0,0,0)>0 && bs(-5,-5,-5)>0);
chk('valori non numerici non producono NaN', Number.isFinite(bs(undefined,null,NaN)));
chk('non ingrandisce mai oltre il dpr richiesto', bs(400,300,2)<=2);

console.log('-- concetti: quota del documento dedicata a ciascun concetto --');
// 3 concetti x 10 brani. Il concetto 0 domina 7 brani, il concetto 1 ne
// domina 2, il concetto 2 uno solo: "parla molto di AI, poco di relazioni".
const sims=[[],[],[]];
for (let j=0;j<10;j++){
  const top= j<7?0 : j<9?1 : 2;
  for (let i=0;i<3;i++) sims[i].push(i===top?0.82:0.61);
}
const sh=CO.prominence(sims);
chk('le quote sommano a 1', Math.abs(sh.reduce((a,v)=>a+v,0)-1)<1e-9);
chk('il tema presente ovunque ha la quota maggiore', sh[0]>sh[1] && sh[1]>sh[2]);
chk('il tema citato una volta ha una quota piccola', sh[2]<0.2);
// Stessi rapporti, scala di coseni diversa (un altro modello): stesso risultato.
// E' il motivo della standardizzazione: la lezione dei "13 documenti, 1 collegamento".
const other=sims.map(r=>r.map(v=>0.4+0.5*v));
const sh2=CO.prominence(other);
chk('indipendente dalla scala dei coseni del modello', sh.every((v,i)=>Math.abs(v-sh2[i])<1e-9));
chk('un solo concetto prende tutto', Math.abs(CO.prominence([[0.7,0.8]])[0]-1)<1e-9);
chk('nessun brano: quote uniformi', CO.prominence([[],[]]).every(v=>Math.abs(v-0.5)<1e-9));
chk('coseni mancanti non producono NaN', CO.prominence([[NaN,0.8],[0.7,0.6]]).every(Number.isFinite));
chk('shareOf ignora le maiuscole', CO.shareOf({c:[['Intelligenza artificiale',382]]},'intelligenza ARTIFICIALE')===0.382);
chk('shareOf: concetto assente = 0', CO.shareOf({c:[['a',10]]},'b')===0 && CO.shareOf(null,'a')===0);

console.log('-- concetti: finestre di testo dall\'inizio alla fine --');
const doc='INIZIO'+'x'.repeat(50000)+'FINE';
const win=U.windows(doc,10,900);
chk('10 finestre', win.length===10);
chk('la prima parte dall\'inizio', win[0].startsWith('INIZIO'));
chk('l\'ultima arriva alla fine', win[9].endsWith('FINE'));
chk('ogni finestra entro la dimensione', win.every(w=>w.length<=900));
chk('testo corto: una sola finestra', U.windows('breve testo',10,900).length===1);
chk('testo vuoto: nessuna finestra', U.windows('',10,900).length===0 && U.windows(null,10,900).length===0);
chk('non inventa finestre sovrapposte su testi medi', U.windows('y'.repeat(2000),10,900).length===3);

console.log('-- concetti: normalizzazione dell\'elenco del modello --');
const nc=P.normalizeConcepts(['  Intelligenza  artificiale. ','intelligenza artificiale','1. legami parasociali','x','', null,'Memoria autobiografica'],['Memoria autobiografica'.toLowerCase().replace('m','M')],12);
chk('spazi e punteggiatura ripuliti', nc[0]==='Intelligenza artificiale');
chk('duplicati (maiuscole) rimossi', nc.filter(c=>c.toLowerCase()==='intelligenza artificiale').length===1);
chk('numerazione rimossa', nc.includes('legami parasociali'));
chk('voci troppo corte o vuote scartate', !nc.includes('x') && !nc.includes('') && nc.every(Boolean));
chk('adotta la grafia gia usata in biblioteca',
  P.normalizeConcepts(['memoria AUTOBIOGRAFICA'],['Memoria autobiografica'],12)[0]==='Memoria autobiografica');
chk('rispetta il massimo', P.normalizeConcepts(['a1','b2','c3','d4'],[],2).length===2);
chk('il prompt vieta i punteggi (li misura il testo)', /Non dare punteggi/.test(P.buildConceptPrompt('doc',[])));
chk('il prompt passa il vocabolario esistente', P.buildConceptPrompt('doc',['legami parasociali']).includes('legami parasociali'));

console.log('-- colonna Pertinenza: chiave di ordinamento --');
const keys=[0,0.004,0.05,0.382,0.4,1].map(U.sortKey);
chk('larghezza fissa', keys.every(k=>k.length===4));
chk('ordine alfabetico = ordine numerico', keys.every((k,i)=>i===0||k>=keys[i-1]));
chk('ordine anche con collazione numerica', keys.slice().sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).join()===keys.join());
chk('valori fuori scala limitati', U.sortKey(7)==='1000' && U.sortKey(-3)==='0000' && U.sortKey(NaN)==='0000');

console.log('-- embedding a lotti --');
chk('lotti da 32', JSON.stringify(P.batches(Array.from({length:70},(_,i)=>i),32).map(b=>b.length))==='[32,32,6]');
chk('lista vuota: nessun lotto', P.batches([],32).length===0);
chk('NVIDIA: una richiesta con piu testi', JSON.stringify(P.Nvidia.buildBody(['a','b'],'passage','m').input)==='["a","b"]');
const resp={data:[{index:1,embedding:[2]},{index:0,embedding:[1]},{index:2}]};
const parsed=P.Nvidia.parseResponse(resp,3);
chk('vettori riordinati per index', parsed[0][0]===1 && parsed[1][0]===2);
chk('vettore mancante = null, non spostato', parsed[2]===null);
chk('risposta vuota: tutti null', P.Nvidia.parseResponse(null,2).every(v=>v===null));

console.log('-- archivio sincronizzato: note --');
const tricky={
  ABCD1234:{t:5,c:[['AI & <società>',382],['"citazioni"',61],['l\'altro',10],['</pre> tentativo',5],['città ✓',1]]},
  EFGH5678:{t:9,c:[['memoria',500]]}
};
const html=ST.encode({shards:4,index:2,entries:tricky});
const back=ST.decode(html);
chk('andata e ritorno senza perdite', JSON.stringify(back.entries)===JSON.stringify(tricky));
chk('metadati del blocco conservati', back.shards===4 && back.index===2);
chk('un "</pre>" in un concetto non rompe la nota', (html.match(/<\/pre>/g)||[]).length===1);
// L'invariante che conta per un VERO parser HTML (l'editor di note di Zotero):
// nel contenuto non deve comparire nessun "<" e nessuna "&" che non sia l'inizio
// di un'entita. Un "<societa" grezzo verrebbe letto come l'apertura di un tag.
const payload=html.match(/<pre>([\s\S]*)<\/pre>/)[1];
chk('nessun "<" grezzo nei dati della nota', !payload.includes('<'));
chk('ogni "&" nei dati e un\'entita', !/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(payload));
chk('la nota contiene il marcatore di ricerca', html.includes(ST.MARKER));
chk('la nota spiega di non modificarla', /Non modificarla/.test(html));
// L'editor di note puo riscrivere l'HTML se l'utente apre la nota.
const edited='<div data-schema-version="9"><h2>x</h2><p>y</p><pre><code>'+
  html.match(/<pre>([\s\S]*?)<\/pre>/)[1].replace(/ /g,'&nbsp;')+'</code></pre></div>';
chk('tollera l\'HTML riscritto dall\'editor di Zotero', JSON.stringify(ST.decode(edited).entries)===JSON.stringify(tricky));
chk('nota estranea: ignorata', ST.decode('<p>una nota qualsiasi</p>')===null && ST.decode('<pre>{"a":1}</pre>')===null);
chk('contenuto corrotto: ignorato, niente eccezioni', ST.decode('<pre>{rotto</pre>')===null);

const m=ST.merge([{entries:{K1:{t:1,c:[['vecchio',1]]},K2:{t:3,c:[]}}},{entries:{K1:{t:2,c:[['nuovo',1]]}}}]);
chk('fusione: vince la voce piu recente', m.K1.c[0][0]==='nuovo');
chk('fusione: le altre voci restano', !!m.K2);
chk('fusione indipendente dall\'ordine delle note',
  ST.merge([{entries:{K1:{t:2,c:[['nuovo',1]]}}},{entries:{K1:{t:1,c:[['vecchio',1]]}}}]).K1.c[0][0]==='nuovo');

chk('stesso documento, stesso blocco', ST.shardOf('ABCD1234',8)===ST.shardOf('ABCD1234',8));
chk('blocco sempre nell\'intervallo', ['A','B','C','ZZZZ9999','Q1W2E3R4'].every(k=>{const s=ST.shardOf(k,8);return s>=0&&s<8;}));
const parts=ST.partition(tricky,4);
chk('la suddivisione non perde voci', parts.reduce((a,g)=>a+Object.keys(g).length,0)===2);

// Una biblioteca grande deve finire in blocchi che Zotero riesce a sincronizzare.
const big={};
for (let i=0;i<1500;i++){
  const c=[]; for(let j=0;j<12;j++) c.push(['concetto piuttosto lungo numero '+j,100+j]);
  big['K'+String(i).padStart(7,'0')]={t:i,c};
}
const shardsNeeded=ST.planShards(big,2,ST.LIMIT);
const worst=Math.max(...ST.partition(big,shardsNeeded).map((g,i)=>ST.encode({shards:shardsNeeded,index:i,entries:g}).length));
chk('1500 documenti: ogni nota sotto il limite ('+shardsNeeded+' blocchi, max '+worst+' car.)', worst<=ST.LIMIT);
chk('piccola biblioteca: minimo di blocchi', ST.planShards(tricky,2,ST.LIMIT)===ST.MIN_SHARDS);
chk('il limite resta ben sotto quello dichiarato da Zotero', ST.LIMIT<=80000);

console.log('-- modelli ritirati da Google --');
// text-embedding-004 e' stato spento il 14 gennaio 2026: chi aveva installato il
// plugin prima lo aveva salvato nelle preferenze, e cambiare solo il valore
// predefinito non lo avrebbe mai raggiunto.
chk('i predefiniti non sono modelli ritirati',
  !Object.keys(U.RETIRED).some(k=>Object.prototype.hasOwnProperty.call(U.RETIRED[k],U.DEFAULTS[k])));
chk('embedding predefinito con supporto ai task type', U.DEFAULTS.geminiEmbedModel==='gemini-embedding-001');
U.set('geminiEmbedModel','text-embedding-004'); U.set('geminiModel','gemini-2.5-flash');
const mig=U.migratePrefs();
chk('embedding ritirato sostituito', U.get('geminiEmbedModel')==='gemini-embedding-001');
chk('modello dei tag ritirato sostituito', U.get('geminiModel')==='gemini-flash-latest');
chk('le sostituzioni vengono riportate nel log', mig.length===2);
U.set('geminiModel','gemini-3.7-flash');
chk('un modello scelto dall\'utente non viene toccato', U.migratePrefs().length===0 && U.get('geminiModel')==='gemini-3.7-flash');
U.set('geminiModel',U.DEFAULTS.geminiModel);
chk('testo per gli embedding entro il limite di gemini-embedding-001', P.Gemini.EMBED_CHARS<=6000);

console.log('-- ripiego se un modello non esiste piu (404) --');
(async()=>{
  const G=P.Gemini, calls=[];
  U.set('geminiModel','modello-spento');
  P.lastNotice=null;
  const r=await G._withModel('geminiModel',G.FALLBACK_MODEL,async m=>{calls.push(m); if(m==='modello-spento'){const e=new Error('404');e.status=404;throw e;} return 'ok:'+m;});
  chk('usa il modello di ripiego', r==='ok:'+G.FALLBACK_MODEL && calls.join()==='modello-spento,'+G.FALLBACK_MODEL);
  chk('lo segnala all\'utente', /non esiste piu/.test(P.lastNotice||''));
  let rethrown=false;
  try { await G._withModel('geminiModel',G.FALLBACK_MODEL,async()=>{const e=new Error('quota');e.status=429;throw e;}); }
  catch(e){ rethrown=e.status===429; }
  chk('altri errori (es. 429) non attivano il ripiego', rethrown);
  U.set('geminiModel',G.FALLBACK_MODEL);
  let n=0, failed=false;
  try { await G._withModel('geminiModel',G.FALLBACK_MODEL,async()=>{n++;const e=new Error('404');e.status=404;throw e;}); }
  catch(e){ failed=true; }
  chk('nessun ciclo se anche il ripiego manca', failed && n===1);
  U.set('geminiModel',U.DEFAULTS.geminiModel);
  finish();
})();

function finish(){
console.log('-- ogni documento .xhtml e XML ben formato --');
// Un .xhtml viene letto come XML: anche un "<canvas>" dentro un commento CSS
// apre un tag, e il documento intero non viene caricato -- senza alcun errore
// visibile in Zotero.
{
  const {execFileSync}=require('child_process'), P=require('path');
  const docs=['content','prefs'].flatMap(d=>fs.readdirSync(P.join(__dirname,'..',d))
    .filter(f=>f.endsWith('.xhtml')).map(f=>P.join(__dirname,'..',d,f)));
  let haveLint=true;
  try { execFileSync('xmllint',['--version'],{stdio:'ignore'}); } catch(e){ haveLint=false; }
  if (!haveLint) console.log('  (xmllint non disponibile: controllo saltato)');
  else for (const f of docs) {
    let ok=true, msg='';
    try { execFileSync('xmllint',['--noout',f],{stdio:'pipe'}); }
    catch(e){ ok=false; msg=String(e.stderr||e).split('\n')[0]; }
    chk(P.relative(P.join(__dirname,'..'),f)+' ben formato'+(ok?'':' -> '+msg), ok);
  }
}

console.log('-- il canvas non si misura da solo (ciclo di raddoppio) --');
// <canvas> e un elemento sostituito: in posizione assoluta left/right non lo
// allargano e la sua larghezza segue il bitmap. Misurarlo per dimensionare il
// bitmap raddoppiava entrambi a ogni frame fino a "Canvas exceeds max size".
const graphX=fs.readFileSync(__dirname+'/../content/graph.xhtml','utf8');
chk('il codice misura lo stage, mai il canvas', !/canvas\.client(Width|Height)/.test(graphSrc));
chk('il canvas e dentro uno stage', /<div id="stage">\s*<canvas id="canvas">/.test(graphX));
chk('il canvas riempie lo stage con dimensioni CSS esplicite',
  /#canvas\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/.test(graphX));

console.log('-- calibrazione dei coseni sul set di documenti --');
const cal=S.calibrate([0.80,0.81,0.82,0.83,0.84,0.85,0.86,0.87,0.88,0.95]);
chk('la coppia mediana vale 0', cal(0.84)===0);
chk('la coppia migliore vale 1', cal(0.95)===1);
chk('crescente fra mediana e vertice', cal(0.86)>0 && cal(0.86)<cal(0.88));
// Il caso reale: coseni tutti fuori dalla finestra fissa 0.55-0.92.
const alti=[0.93,0.935,0.94,0.945,0.95,0.955,0.96,0.965,0.97,0.975];
chk('con coseni tutti alti la finestra fissa appiattisce tutto', alti.every(c=>S.rescale(c)===1));
chk('la calibrazione li distingue comunque', S.calibrate(alti)(0.975)>S.calibrate(alti)(0.955));
chk('set troppo piccolo: finestra fissa', S.calibrate([0.7])(0.7)===S.rescale(0.7));
chk('set costante: nessuna divisione per zero', Number.isFinite(S.calibrate([0.9,0.9,0.9,0.9])(0.9)));
chk('NaN ignorati', S.calibrate([NaN,0.8,0.85,0.9,0.95])(0.95)===1);

console.log('-- selezione dei collegamenti --');
// 4 documenti: 0-1 fortissimo, il resto debole sotto soglia.
const n4=4, W=new Array(16).fill(0);
const setW=(i,j,w)=>{W[S.pairIndex(n4,i,j)]=w;};
setW(0,1,0.9); setW(0,2,0.05); setW(1,3,0.04); setW(2,3,0.03);
const E=S.selectEdges(n4,W,0.12,2);
const has=(i,j)=>E.some(e=>e.s===i&&e.t===j);
chk('sopra soglia mantenuto', has(0,1));
chk('nessun documento isolato se ha un vicino', [0,1,2,3].every(i=>E.some(e=>e.s===i||e.t===i)));
chk('nessun collegamento duplicato', new Set(E.map(e=>e.s+'-'+e.t)).size===E.length);
chk('peso zero non crea collegamenti', S.selectEdges(3,new Array(9).fill(0),0.12,2).length===0);
chk('s sempre minore di t', E.every(e=>e.s<e.t));

console.log('-- finestre: ogni URL chrome:// deve puntare a un file esistente --');
// La rete di relazioni si apriva vuota perche' openDialog() ignora in silenzio
// l'URL jar: di un plugin impacchettato. Ora usiamo chrome://, che pero' fallisce
// altrettanto silenziosamente se il file non c'e': qui lo verifichiamo.
const path=require('path'), root=path.join(__dirname,'..');
const srcFiles=fs.readdirSync(path.join(root,'src')).map(f=>'src/'+f);
let urls=[];
for (const f of srcFiles) {
  const t=fs.readFileSync(path.join(root,f),'utf8');
  urls=urls.concat(t.match(/chrome:\/\/zotero-semantic\/content\/[A-Za-z0-9._-]+/g)||[]);
}
chk('almeno una finestra del plugin e dichiarata', urls.length>0);
const missingWin=urls.filter(u=>!fs.existsSync(path.join(root,'content',u.split('/content/')[1])));
chk('tutti i documenti delle finestre esistono'+(missingWin.length?' -> '+missingWin:''), missingWin.length===0);

// Anche i riferimenti interni ai documenti (script e fogli di stile): un src
// sbagliato qui produce di nuovo una finestra che sembra rotta senza errori.
const missingRef=[];
for (const f of fs.readdirSync(path.join(root,'content')).filter(f=>f.endsWith('.xhtml'))) {
  const t=fs.readFileSync(path.join(root,'content',f),'utf8');
  for (const m of t.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!fs.existsSync(path.join(root,'content',m[1]))) missingRef.push(f+' -> '+m[1]);
  }
}
chk('script e css referenziati esistono'+(missingRef.length?' -> '+missingRef:''), missingRef.length===0);

// Ogni getElementById deve trovare un id davvero presente nel documento: un id
// sbagliato da null, e null.textContent interrompe lo script a meta' lasciando
// una finestra che sembra funzionante ma non fa nulla.
const missingId=[];
for (const js of fs.readdirSync(path.join(root,'content')).filter(f=>f.endsWith('.js'))) {
  const xhtml=path.join(root,'content',js.replace(/\.js$/,'.xhtml'));
  if (!fs.existsSync(xhtml)) continue;
  const markup=fs.readFileSync(xhtml,'utf8');
  const code=fs.readFileSync(path.join(root,'content',js),'utf8');
  for (const m of code.matchAll(/getElementById\("([^"]+)"\)/g)) {
    if (!markup.includes('id="'+m[1]+'"')) missingId.push(js+' -> #'+m[1]);
  }
}
chk('gli id usati dagli script esistono nel markup'+(missingId.length?' -> '+missingId:''), missingId.length===0);

// save() e restore() del contesto 2D devono bilanciarsi: un frame interrotto
// fra i due fa crescere lo stack e sfasa tutti i frame successivi.
for (const js of fs.readdirSync(path.join(root,'content')).filter(f=>f.endsWith('.js'))) {
  const code=fs.readFileSync(path.join(root,'content',js),'utf8');
  const saves=(code.match(/ctx\.save\(\)/g)||[]).length;
  const restores=(code.match(/ctx\.restore\(\)/g)||[]).length;
  if (saves||restores) chk('save/restore bilanciati in '+js, saves===restores);
}

// La registrazione chrome punta a content/: se qualcuno rinomina la cartella o
// la dimentica nel pacchetto, le finestre tornano vuote.
const boot=fs.readFileSync(path.join(root,'bootstrap.js'),'utf8');
chk('bootstrap registra il pacchetto chrome', boot.includes('registerChrome'));
chk('registra la cartella content/', /\["content", "zotero-semantic", "content\/"\]/.test(boot));
chk('rilascia la registrazione alla chiusura', boot.includes('chromeHandle.destruct()'));
chk('content/ finisce nel pacchetto', /^\s*content \\$/m.test(fs.readFileSync(path.join(root,'build.sh'),'utf8')));

console.log('\n'+pass+' passati, '+fail+' falliti');
process.exit(fail?1:0);
}
