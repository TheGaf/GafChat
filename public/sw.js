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
    self.registration.showNotification(data.title||"GafChat",{
      body:data.body||"",
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
  ).href;

  event.waitUntil(
    clients.matchAll({
      type:"window",
      includeUncontrolled:true
    }).then(list=>{
      for(const client of list){
        if(new URL(client.url).origin===self.location.origin){
          return client.navigate(target).then(()=>client.focus());
        }
      }

      return clients.openWindow(target);
    })
  );
});
