/** Agent Step v1, published by Autopilot. Values select authenticated root input;
 * the receiver URL is installation configuration, never participant/model data. */
export function activityWebhookConfiguration(url:string) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.port&&parsed.port!=='443'||parsed.username||parsed.password||parsed.hash||parsed.search||parsed.href!==url||parsed.pathname!=='/api/v1/pipeline/activity')throw Error('canonical_activity_receiver_required');
  return {url,correlation:{requestId:'$.requestId',projectId:'$.projectId',workshopId:'$.workshopId',nativeRequestId:'$.nativeRequestId',generation:'$.activityGeneration'}};
}
