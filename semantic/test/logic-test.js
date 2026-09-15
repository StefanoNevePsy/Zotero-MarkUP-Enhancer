const fs=require('fs'),vm=require('vm');
const prefs={};
const ctx={ZoteroSemantic:{log:()=>{}},Zotero:{Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v}},console};
vm.createContext(ctx);
for (const f of ['src/utils.js','src/similarity.js'].map(p=>__dirname+'/../'+p)) vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const U=ctx.ZoteroSemantic.Utils, S=ctx.ZoteroSemantic.Similarity;
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

console.log('\n'+pass+' passati, '+fail+' falliti');
process.exit(fail?1:0);
