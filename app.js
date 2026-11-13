import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {getFirestore,collection,doc,getDoc,onSnapshot,setDoc,updateDoc,runTransaction,serverTimestamp,query,orderBy} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// GitHub Pagesではプログラムだけを配信します。取引データはFirestoreに保存します。
const $ = id => document.getElementById(id);
const DAYS = ['2026-11-14','2026-11-15'];
const YAKISOBA_PRICE = 400;
const TARGET_YAKISOBA = 240;
const DEMO_SALES_KEY = 'kiyokasai-register-demo-sales-v2';
const DEMO_PRICE_KEY = 'kiyokasai-register-demo-riceprice-v2';
const PENDING_KEY = 'kiyokasai-register-pending-v2';
const yen = n => '¥' + Number(n || 0).toLocaleString('ja-JP');
const safeInt = n => Number.isSafeInteger(n) && n >= 0;
const tokyoToday = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  return DAYS.includes(key) ? key : DAYS[0];
};
const readJSON = (key,fallback) => {try{return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback}catch{return fallback}};
let auth=null, db=null, me=null, staff=null, demo=false, sales=[], ricePrice=null;
let yakisobaQty=0, riceQty=0, stage='pick', pending=false, attempt=readJSON(PENDING_KEY,null), historyPage=0;
let unsubscribeSales=null, unsubscribeMenu=null, currentView='register', toastTimeout=null;
$('saleDay').value = tokyoToday();

function display(id){for(const x of ['setup','login','app'])$(x).classList.toggle('hidden',x!==id)}
function status(value){$('connection').textContent=value}
function flash(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('toast').classList.add('hidden'),4300)}
function errMsg(e){const code=e?.code||'';if(/invalid-credential|wrong-password|user-not-found/.test(code))return 'メールアドレスまたはパスワードが違います。';if(code.includes('permission-denied'))return 'アクセス権限がありません。Firestoreルールとスタッフ登録を確認してください。';if(/unavailable|network/.test(code))return 'ネットワークにつながりません。通信状態を確認してください。';return 'エラー：'+(e?.message || String(e))}
function configReady(){const c=window.FIREBASE_CONFIG||{};return !!(c.apiKey&&c.projectId&&c.appId)}
function validRicePrice(price){return Number.isSafeInteger(price)&&price>=1&&price<=1000}
function orderTotal(){return yakisobaQty*YAKISOBA_PRICE + riceQty*(validRicePrice(ricePrice)?ricePrice:0)}
function orderCount(){return yakisobaQty+riceQty}
function setView(view){currentView=view;document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('is-active',x.dataset.view===view));for(const x of document.querySelectorAll('.view'))x.classList.toggle('hidden',x.id!==view);if(view==='history'){historyPage=0;renderHistory()}if(view==='dashboard')renderDashboard()}
function setStage(next){stage=next;$('pickStep').classList.toggle('hidden',next!=='pick');$('paymentStep').classList.toggle('hidden',next!=='payment');$('receipt').classList.toggle('hidden',next!=='receipt');if(next==='payment'){$('orderDetails').textContent=`焼きそば ${yakisobaQty}食 / ご飯 ${riceQty}食`;$('paymentTotal').textContent=yen(orderTotal());$('paid').value='';$('payError').textContent='';calcChange()}if(next==='pick')$('pickError').textContent=''}
function updatePick(){yakisobaQty=Math.max(0,Math.min(30,yakisobaQty));riceQty=Math.max(0,Math.min(30,riceQty));$('yQty').textContent=yakisobaQty;$('rQty').textContent=riceQty;$('itemsCount').textContent=orderCount()+'点';$('pickTotal').textContent=yen(orderTotal());$('ricePriceLabel').textContent=validRicePrice(ricePrice)?`1食 ${yen(ricePrice)}`:'価格未設定（集計・設定で登録）';$('goPayment').disabled=pending || !!attempt || orderCount()===0 || (riceQty>0&&!validRicePrice(ricePrice));$('goPayment').title=riceQty>0&&!validRicePrice(ricePrice)?'先に管理者がご飯の販売価格を設定してください。':'';renderPending()}
function calcChange(){const raw=$('paid').value;const paid=raw===''?null:Number(raw);const change=paid===null?null:paid-orderTotal();$('change').textContent=change===null?'—':change<0?'不足 '+yen(-change):yen(change);$('checkout').disabled=pending||raw===''||!safeInt(paid)||paid<orderTotal()||paid>1000000}
function resetOrder(){yakisobaQty=0;riceQty=0;$('paid').value='';updatePick();setStage('pick')}
function saleParts(s){const y=Number.isInteger(s.yakisobaQty)?s.yakisobaQty:(Number.isInteger(s.qty)?s.qty:0);const r=Number.isInteger(s.riceQty)?s.riceQty:0;return {y,r}}
function effective(s){return s.status==='sale'}
function dateDisplay(s){if(s.soldAt?.toDate)return s.soldAt.toDate().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});if(s.clientTime){const d=new Date(s.clientTime);if(!Number.isNaN(d.getTime()))return d.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}return '日時未取得'}
function sortSales(a,b){const time=s=>(s.soldAt?.seconds||0)*1000 || Date.parse(s.clientTime||'')||0;return time(b)-time(a)}
function allValid(day=null){return sales.filter(s=>effective(s)&&(!day||s.dateKey===day))}
function summary(day=null){const items=allValid(day);return items.reduce((a,s)=>{const q=saleParts(s);a.y+=q.y;a.r+=q.r;a.total+=Number(s.total)||0;a.count++;return a},{y:0,r:0,total:0,count:0})}
function renderDashboard(){const a=summary(DAYS[0]),b=summary(DAYS[1]),t=summary();$('rev14').textContent=yen(a.total);$('rev15').textContent=yen(b.total);$('revAll').textContent=yen(t.total);$('countAll').textContent=t.count+'件';$('yAll').textContent=t.y+'食';$('rAll').textContent=t.r+'食';$('remaining').textContent=t.y>=TARGET_YAKISOBA?'達成！':`残り${TARGET_YAKISOBA-t.y}食`;$('progressFill').style.width=Math.min(100,t.y/TARGET_YAKISOBA*100)+'%';$('riceStatus').textContent=validRicePrice(ricePrice)?yen(ricePrice):'未設定';$('priceForm').classList.toggle('hidden',staff?.role!=='admin');if(document.activeElement!==$('ricePriceInput'))$('ricePriceInput').value=validRicePrice(ricePrice)?String(ricePrice):''}
function historyPerPage(){return window.innerHeight<660?3:4}
function renderHistory(){const list=$('historyList');list.replaceChildren();const filter=$('historyDay').value;const items=sales.filter(x=>filter==='all'||x.dateKey===filter).sort(sortSales);const size=historyPerPage();const pages=Math.max(1,Math.ceil(items.length/size));historyPage=Math.max(0,Math.min(historyPage,pages-1));const slice=items.slice(historyPage*size,(historyPage+1)*size);if(!slice.length){const e=document.createElement('p');e.className='empty';e.textContent='まだ取引がありません';list.append(e)}for(const s of slice){const q=saleParts(s);const item=document.createElement('article');item.className='history-row'+(!effective(s)?' is-void':'');const main=document.createElement('div');main.className='history-main';const amount=document.createElement('div');amount.className='history-amount';amount.textContent=yen(s.total);const products=document.createElement('div');products.className='history-products';products.textContent=`焼きそば ${q.y}食・ご飯 ${q.r}食`;const meta=document.createElement('div');meta.className='history-meta';meta.textContent=`${dateDisplay(s)} · ${s.staffName||'スタッフ'}`;main.append(amount,products,meta);item.append(main);if(!effective(s)){const badge=document.createElement('span');badge.className='void-label';badge.textContent='取消済み';item.append(badge)}else if(staff?.role==='admin'||(me&&s.staffUid===me.uid)||demo){const cancel=document.createElement('button');cancel.type='button';cancel.className='cancel-btn';cancel.textContent='取消';cancel.onclick=()=>showVoidDialog(s);item.append(cancel)}list.append(item)}$('pageInfo').textContent=`${historyPage+1} / ${pages}`;$('prevPage').disabled=historyPage===0;$('nextPage').disabled=historyPage>=pages-1}
function render(){updatePick();renderHistory();renderDashboard()}
function activeUI(){display('app');$('logout').classList.remove('hidden');$('mode').textContent=demo?'デモ（本番売上ではありません）':'Firebaseリアルタイム同期';$('userLabel').textContent=staff?.name||'デモスタッフ';status(demo?'デモ':'接続中');render();setView('register');setStage('pick');if(attempt&&!demo)flash('前回の取引の保存結果が未確認です。売上の重複を防ぐため状態を確認してください。')}
function renderPending(){const el=$('pendingBanner');if(el)el.classList.toggle('hidden',!attempt||demo)}

$('yMinus').onclick=()=>{yakisobaQty--;updatePick()};$('yPlus').onclick=()=>{yakisobaQty++;updatePick()};$('rMinus').onclick=()=>{riceQty--;updatePick()};$('rPlus').onclick=()=>{riceQty++;updatePick()};
$('goPayment').onclick=()=>{if(orderCount()===0){$('pickError').textContent='商品を1点以上選んでください。';return}if(riceQty>0&&!validRicePrice(ricePrice)){$('pickError').textContent='管理者が「集計・設定」からご飯の価格を登録してください。';return}if(attempt){$('pickError').textContent='前回の未確認会計を先に確認してください。';return}setStage('payment')};
$('backToPick').onclick=()=>{if(!pending)setStage('pick')};
$('paid').addEventListener('input',calcChange);
document.querySelectorAll('[data-cash]').forEach(button=>button.onclick=()=>{$('paid').value=button.dataset.cash==='exact'?String(orderTotal()):button.dataset.cash;calcChange()});
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>setView(button.dataset.view));
$('prevPage').onclick=()=>{historyPage--;renderHistory()};$('nextPage').onclick=()=>{historyPage++;renderHistory()};$('historyDay').onchange=()=>{historyPage=0;renderHistory()};window.addEventListener('resize',()=>{if(currentView==='history')renderHistory()});
$('receiptNext').onclick=resetOrder;
$('saleDay').onchange=()=>{$('pickError').textContent=''};

function saveAttempt(){try{localStorage.setItem(PENDING_KEY,JSON.stringify(attempt))}catch{}}
function clearAttempt(){attempt=null;localStorage.removeItem(PENDING_KEY);renderPending()}
function createPayload(){const paid=Number($('paid').value);return {dateKey:$('saleDay').value,yakisobaQty,riceQty,yakisobaUnitPrice:YAKISOBA_PRICE,riceUnitPrice:riceQty?ricePrice:0,total:orderTotal(),paid,change:paid-orderTotal(),status:'sale',staffUid:demo?'demo':me.uid,staffName:staff?.name||'スタッフ',clientTime:new Date().toISOString()}}
function showReceipt(s){const q=saleParts(s);$('receiptText').textContent=`焼きそば ${q.y}食 / ご飯 ${q.r}食\n合計 ${yen(s.total)} ・ お釣り ${yen(s.change)}`;$('receiptText').style.whiteSpace='pre-line';setStage('receipt')}
async function writeSale(id,data){const ref=doc(db,'sales',id);const outcome=await runTransaction(db,async tx=>{const prior=await tx.get(ref);if(prior.exists())return {duplicate:true,existing:prior.data()};tx.set(ref,{...data,soldAt:serverTimestamp()});return {duplicate:false}});return outcome}
async function confirmCheckout(){if(pending)return;$('payError').textContent='';const p=Number($('paid').value);if(!DAYS.includes($('saleDay').value)||orderCount()===0||orderCount()>60||!safeInt(p)||$('paid').value===''||p<orderTotal()||p>1000000){$('payError').textContent='注文とお預かり金額を確認してください。';return}if(riceQty>0&&!validRicePrice(ricePrice)){$('payError').textContent='ご飯の価格が未設定です。';return}if(attempt){$('payError').textContent='保存未確認の取引があります。「保存状態を確認」を先に押してください。';return}attempt={id:crypto.randomUUID(),data:createPayload()};if(!demo)saveAttempt();pending=true;$('checkout').disabled=true;$('checkout').textContent='保存中…';try{if(demo){sales.unshift({...attempt.data,id:attempt.id,soldAt:{seconds:Math.floor(Date.now()/1000)}});localStorage.setItem(DEMO_SALES_KEY,JSON.stringify(sales))}else{await writeSale(attempt.id,attempt.data)}const data=attempt.data;clearAttempt();render();showReceipt(data);status(demo?'デモ':'同期中')}catch(e){$('payError').textContent=errMsg(e)+' 同じ会計番号で再確認してください。';flash('会計の保存が確認できません。通信状態を確認してください。')}finally{pending=false;$('checkout').textContent='会計を確定する';calcChange()}}
$('checkout').onclick=confirmCheckout;

function showVoidDialog(s){const dialog=$('voidDialog');if(pending)return;const parts=saleParts(s);$('voidDescription').textContent=`${yen(s.total)}（焼きそば ${parts.y}食・ご飯 ${parts.r}食）`;dialog.dataset.saleId=s.id;dialog.returnValue='no';dialog.showModal()}
$('voidDialog').addEventListener('close',async()=>{if($('voidDialog').returnValue!=='yes')return;const id=$('voidDialog').dataset.saleId;const target=sales.find(s=>s.id===id);if(!target||!effective(target))return;try{if(demo){target.status='void';target.voidedBy='demo';target.voidedAt=new Date().toISOString();localStorage.setItem(DEMO_SALES_KEY,JSON.stringify(sales));render()}else{await updateDoc(doc(db,'sales',id),{status:'void',voidedBy:me.uid,voidedAt:serverTimestamp()})}flash('会計を取り消しました（履歴は残ります）')}catch(e){flash('取消に失敗：'+errMsg(e))}});

$('priceForm').onsubmit=async e=>{e.preventDefault();$('priceError').textContent='';if(staff?.role!=='admin')return;const price=Number($('ricePriceInput').value);if(!validRicePrice(price)){$('priceError').textContent='価格は1〜1,000円の整数で入力してください。';return}const button=$('priceForm').querySelector('button');button.disabled=true;try{if(demo){ricePrice=price;localStorage.setItem(DEMO_PRICE_KEY,String(price));render()}else{await setDoc(doc(db,'settings','menu'),{ricePrice:price,updatedAt:serverTimestamp(),updatedBy:me.uid})}flash(`ご飯の価格を ${yen(price)} に設定しました`)}catch(err){$('priceError').textContent=errMsg(err)}finally{button.disabled=false}};

function csvSafe(x){let s=String(x??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'}
$('exportCsv').onclick=()=>{const rows=[['取引ID','販売日','日時','担当者','焼きそば食数','焼きそば単価','ご飯食数','ご飯単価','合計','預かり','釣銭','状態','取消者'],...sales.slice().sort(sortSales).map(s=>{const q=saleParts(s);return [s.id,s.dateKey,dateDisplay(s),s.staffName,q.y,s.yakisobaUnitPrice??s.unitPrice??400,q.r,s.riceUnitPrice??0,s.total,s.paid,s.change,s.status==='void'?'取消済み':'有効',s.voidedBy||'']})];const csv='\ufeff'+rows.map(row=>row.map(csvSafe).join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='kiyokasai-sales-2026.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),2000)};

$('demoStart').onclick=()=>{demo=true;attempt=null;staff={name:'デモスタッフ',role:'admin'};try{sales=readJSON(DEMO_SALES_KEY,[]);if(!Array.isArray(sales))sales=[]}catch{sales=[]}const price=Number(localStorage.getItem(DEMO_PRICE_KEY));ricePrice=validRicePrice(price)?price:null;activeUI()};
$('logout').onclick=async()=>{if(demo){demo=false;staff=null;sales=[];ricePrice=null;$('logout').classList.add('hidden');showSetup()}else if(auth){try{await signOut(auth)}catch(e){flash(errMsg(e))}}};
function showSetup(){display('setup');status('設定待ち')}
$('loginForm').onsubmit=async e=>{e.preventDefault();$('loginError').textContent='';const button=e.target.querySelector('button');button.disabled=true;try{await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value)}catch(err){$('loginError').textContent=errMsg(err)}finally{button.disabled=false}};
function stopListeners(){if(unsubscribeSales){unsubscribeSales();unsubscribeSales=null}if(unsubscribeMenu){unsubscribeMenu();unsubscribeMenu=null}}
async function initialize(){if(!configReady()){showSetup();return}try{const app=initializeApp(window.FIREBASE_CONFIG);auth=getAuth(app);db=getFirestore(app);onAuthStateChanged(auth,async user=>{stopListeners();me=user;staff=null;sales=[];ricePrice=null;if(!user){display('login');$('logout').classList.add('hidden');status('ログイン待ち');return}try{const record=await getDoc(doc(db,'staff',user.uid));if(!record.exists()||record.data().active!==true||!['admin','cashier'].includes(record.data().role)){await signOut(auth);$('loginError').textContent='スタッフ権限がありません。管理者に登録を依頼してください。';return}staff=record.data();activeUI();unsubscribeSales=onSnapshot(query(collection(db,'sales'),orderBy('soldAt','desc')),snapshot=>{sales=snapshot.docs.map(d=>({id:d.id,...d.data()}));status(snapshot.metadata.fromCache?'同期待ち':'同期中');render()},err=>{status('同期エラー');flash(errMsg(err))});unsubscribeMenu=onSnapshot(doc(db,'settings','menu'),snapshot=>{const value=snapshot.exists()?snapshot.data().ricePrice:null;const previousPrice=ricePrice;ricePrice=validRicePrice(value)?value:null;if(stage==='payment'&&riceQty>0&&previousPrice!==ricePrice){setStage('pick');$('pickError').textContent='ご飯の価格が変更されたので、会計金額を再確認してください。';}render()},err=>{status('設定読取エラー');flash(errMsg(err))})}catch(err){display('login');$('loginError').textContent=errMsg(err);status('接続エラー')}})}catch(e){showSetup();flash('Firebaseの接続設定を確認してください。')}}

// 通信エラー後、保存済みの取引を同じ取引IDで照会し、二重登録を防ぎます。
async function verifyPending(){if(!attempt||demo||!db||!me)return;const button=$('checkPending');button.disabled=true;try{const prior=await getDoc(doc(db,'sales',attempt.id));if(prior.exists()){clearAttempt();resetOrder();flash('前回の会計は保存済みでした。履歴を確認してください。');return}await writeSale(attempt.id,attempt.data);const data=attempt.data;clearAttempt();render();showReceipt(data);flash('未確認だった会計を登録・確認しました')}catch(e){flash(errMsg(e)+'。会計番号を保持しています。再度確認してください。')}finally{button.disabled=false}}
$('checkPending').onclick=verifyPending;
initialize();
