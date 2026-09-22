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

console.log('\n'+pass+' passati, '+fail+' falliti');
process.exit(fail?1:0);
