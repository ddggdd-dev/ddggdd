/* 작업대 공용: 메뉴, 날아와 놓이는 종이, 배경 글자, 달린 거리 */
(function(){
  if(/Android/i.test(navigator.userAgent))document.documentElement.classList.add('android');
  var $=function(id){return document.getElementById(id)};
  var help=$('help'),btn=$('mbtn'),close=$('close');
  function open(){help.classList.add('open');close.focus()}
  function shut(){help.classList.remove('open');btn.focus()}
  btn.onclick=open;close.onclick=shut;
  help.addEventListener('click',function(e){if(e.target===help)shut()});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&help.classList.contains('open'))shut()});

  var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.2,rootMargin:'0px 0px -8% 0px'}):null;
  document.querySelectorAll('.rv').forEach(function(el){io?io.observe(el):el.classList.add('in')});

  var mark=$('mark'),km=$('km'),ticking=false;
  function frame(){ticking=false;
    var max=Math.max(1,document.documentElement.scrollHeight-innerHeight),p=Math.min(1,scrollY/max);
    if(mark)mark.style.transform='translateX('+(-p*45)+'vw) rotate(-7deg)';
    if(km)km.textContent=(p*5).toFixed(2);
  }
  addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(frame)}},{passive:true});
  frame();
})();
