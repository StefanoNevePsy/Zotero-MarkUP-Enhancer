const fs=require('fs'),vm=require('vm');
const prefs={};
const ctx={ZoteroSemantic:{log:()=>{}},Zotero:{Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v}},console};
vm.createContext(ctx);
for (const f of ['src/utils.js','src/similarity.js','src/providers.js','src/search.js'].map(p=>__dirname+'/../'+p)) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const U=ctx.ZoteroSemantic.Utils, S=ctx.ZoteroSemantic.Similarity, P=ctx.ZoteroSemantic.Providers, SE=ctx.ZoteroSemantic.Search;
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
