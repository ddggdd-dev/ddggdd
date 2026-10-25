/* 공용: 아스팔트 질감, 휴대폰 메뉴, 결승선 테이프 */
(function(){
  var g=document.getElementById('grain');
  if(g){ var gx=g.getContext('2d');
    var draw=function(){ g.width=innerWidth/2; g.height=innerHeight/2; var d=gx.createImageData(g.width,g.height);
      for(var i=0;i<d.data.length;i+=4){var v=Math.random()*38|0; d.data[i]=d.data[i+1]=d.data[i+2]=v; d.data[i+3]=Math.random()<.5?40:0;}
      gx.putImageData(d,0,0); g.style.width='100%'; g.style.height='100%'; };
    draw(); addEventListener('resize',draw);
  }

  var btn=document.getElementById('menuBtn'), menu=document.getElementById('menu'), close=document.getElementById('menuClose');
  function set(open){ menu.classList.toggle('open',open); btn.setAttribute('aria-expanded',open); document.body.style.overflow=open?'hidden':''; if(open) close.focus(); else btn.focus(); }
  if(btn&&menu){
    btn.addEventListener('click',function(){ set(true); });
    close.addEventListener('click',function(){ set(false); });
    menu.addEventListener('click',function(e){ if(e.target.closest('a')){ menu.classList.remove('open'); btn.setAttribute('aria-expanded',false); document.body.style.overflow=''; } });
    addEventListener('keydown',function(e){ if(e.key==='Escape'&&menu.classList.contains('open')) set(false); });
  }

  var finish=document.getElementById('finish');
  if(finish){ var chk=function(){ if(finish.getBoundingClientRect().top<innerHeight*0.65) finish.classList.add('on'); };
    addEventListener('scroll',chk,{passive:true}); chk(); }
})();
