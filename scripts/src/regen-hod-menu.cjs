// Regenerates artifacts/pos-system/src/lib/hod-menu.ts from the production index.html
// Source of truth: attached_assets/index_*.html (or pass a path as argv[2]).
// Usage: node scripts/src/regen-hod-menu.cjs [path/to/index.html]
const fs=require('fs');
const path=require('path');
const SRC=process.argv[2]||(()=>{
  const dir='attached_assets';
  const f=fs.readdirSync(dir).filter(x=>/^index_.*\.html$/.test(x))
    .map(x=>({x,m:fs.statSync(path.join(dir,x)).mtimeMs}))
    .sort((a,b)=>b.m-a.m)[0];
  if(!f)throw new Error('No attached_assets/index_*.html found');
  return path.join(dir,f.x);
})();
console.log('Reading prod index from',SRC);
const c=fs.readFileSync(SRC,'utf8');
function extract(name){
  // Grab from `var NAME=` up through `];` at end-of-line (the menu literals span many lines)
  const re=new RegExp('var '+name+'=([\\s\\S]*?\\}\\]\\}\\]);','m');
  const m=c.match(re);
  if(!m)throw new Error('not found '+name);
  return new Function('return '+m[1])();
}
const food=extract('HOD_FOOD_MENU');
const bar=extract('HOD_BAR_MENU');

const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

const BAR_GROUP_MAP={
  'Craft Beer':'beer-wine','Bottle Beer':'beer-wine','Can Beer':'beer-wine','Can Beer (330ml)':'beer-wine',
  'Can Beer (500ml)':'beer-wine','Breezers':'beer-wine','Sparkling Wines':'beer-wine','Wines':'beer-wine','Wine':'beer-wine',
  'Single Malt':'spirits','American & Irish Whisky':'spirits','Scotch & Whisky':'spirits','Whisky':'spirits',
  'Black Dog 8 Years':'spirits','Vodka':'spirits','Romanov':'spirits','Rum':'spirits',
  'Carnival':'spirits','Gin':'spirits','Blue Riband':'spirits','Cognac & Brandy':'spirits',
  'Tequila':'spirits','Tequila & More':'spirits','Liquor':'spirits','Liqueurs':'spirits',
  'Signature Mocktails':'cocktails','Mocktails':'cocktails','Cocktails':'cocktails','Shooters':'cocktails',
  'Bubble Blast':'cocktails','Desi Tadka':'cocktails','Flamers':'cocktails','Signature Cocktails':'cocktails',
  'Soft Drinks & Mixers':'soft','Soft Drinks':'soft','Mixers':'soft',
};

let lines=[];let id=1;const labels={};
function emit(group,catKey,catLabel,it,isFood){
  labels[catKey]=catLabel.toUpperCase();
  const o={
    id:`hod${id++}`,
    name:it.n,
    category:catKey,
    group,
    price:it.p,
    isAlcohol:!isFood && group!=='soft',
    available:true,
    isVeg: isFood ? !!it.v : true,
  };
  lines.push(JSON.stringify(o));
}
food.forEach(c=>{
  const key='food-'+slug(c.cat);
  c.items.forEach(it=>emit('food',key,c.cat,it,true));
});
bar.forEach(c=>{
  const g=BAR_GROUP_MAP[c.cat]||'spirits';
  const key=g+'-'+slug(c.cat);
  c.items.forEach(it=>emit(g,key,c.cat,it,false));
});

const out=`// AUTO-GENERATED from production index.html HOD_FOOD_MENU + HOD_BAR_MENU.
// Single source of truth for prices on customer wallet AND BarMode bartender screen.
// To regenerate: drop newest production index.html into attached_assets/, then run:
//   node scripts/src/regen-hod-menu.cjs
import type { MenuItem } from "./types";

export const HOD_CATEGORY_LABELS: Record<string, string> = ${JSON.stringify(labels,null,2)};

export const HOD_GROUP_ORDER = ["spirits","beer-wine","cocktails","soft","food"] as const;
export const HOD_GROUP_LABELS: Record<string,string> = {
  spirits:"🥃 Spirits","beer-wine":"🍺 Beer & Wine",cocktails:"🍹 Cocktails",soft:"🥤 Soft",food:"🍽 Food",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const HOD_MENU_ITEMS: MenuItem[] = ([
${lines.map(l=>'  '+l).join(',\n')}
] as any);
`;
fs.writeFileSync('artifacts/pos-system/src/lib/hod-menu.ts',out);
console.log('food items:',food.reduce((s,c)=>s+c.items.length,0));
console.log('bar items:',bar.reduce((s,c)=>s+c.items.length,0));
console.log('total written:',id-1);
