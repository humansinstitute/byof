const validInstant = value => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export function newestInstant(...values) {
  const dates = values.flat().map(validInstant).filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map(date => date.getTime()))).toISOString();
}

export function activityInstant(event) {
  return event?.type === 'commentary'
    ? newestInstant(event.receivedAt)
    : newestInstant(event?.timestamp);
}

export function collapseActivity(events) {
  const rows = [];
  let tools = null, turn = '';
  for (const event of Array.isArray(events) ? events : []) {
    if (event.turnId !== turn) { turn = event.turnId; tools = null; }
    if (event.type === 'tools') {
      if (tools) tools.instant = newestInstant(tools.instant,event.timestamp);
      else { tools = {type:'tools',turnId:turn,instant:newestInstant(event.timestamp)};rows.push(tools); }
      continue;
    }
    tools = null;
    if (event.type === 'commentary') rows.push({type:'commentary',turnId:turn,content:event.content,instant:newestInstant(event.receivedAt)});
    else if (event.type === 'completed' || event.type === 'failed') rows.push({type:event.type,turnId:turn,instant:newestInstant(event.timestamp)});
  }
  return rows;
}

const dayParts = (date, options={}) => new Intl.DateTimeFormat('en-AU', {
  timeZone:'Australia/Perth', ...options,
}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>`${part.type}:${part.value}`).join('|');

export function perthEventTime(value,label,reference=new Date()) {
  const date=validInstant(value),now=validInstant(reference);
  if(!date||!now)return null;
  const sameDay=dayParts(date,{year:'numeric',month:'2-digit',day:'2-digit'})===dayParts(now,{year:'numeric',month:'2-digit',day:'2-digit'});
  const time=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',hour:'numeric',minute:'2-digit',hour12:true}).format(date);
  const day=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',day:'numeric',month:'short'}).format(date);
  const full=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(date);
  return {datetime:date.toISOString(),text:`${label} ${sameDay?time:`${day}, ${time}`} AWST`,ariaLabel:`${label} ${full}, Australian Western Standard Time`};
}
