self.addEventListener("push",event=>{
  let data={
    title:"GafChat",
    body:"Someone wants to chat",
    url:"/host"
  };

  try{
    if(event.data){
      data={...data,...event.data.json()};
    }
  }catch{}

  event.waitUntil(
    self.registration.showNotification("GafChat",{
      body:"Someone wants to chat",
      icon:"/icons/icon-192.png",
      badge:"/icons/icon-192.png",
      tag:"gafchat-request",
      renotify:true,
      data:{
        url:data.url||"/host"
      }
    })
  );
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();

  const target=new URL(
    event.notification.data?.url||"/host",
    self.location.origin
  );
  const safeTarget=target.origin===self.location.origin?target.href:new URL("/host",self.location.origin).href;

  event.waitUntil(
    clients.matchAll({
      type:"window",
      includeUncontrolled:true
    }).then(list=>{
      for(const client of list){
        if(new URL(client.url).origin===self.location.origin){
          return client.navigate(safeTarget).then(()=>client.focus());
        }
      }

      return clients.openWindow(safeTarget);
    })
  );
});
