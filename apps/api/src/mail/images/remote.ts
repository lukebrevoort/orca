import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";

export const imageByteLimit = 2 * 1024 * 1024;
const excluded = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) excluded.addSubnet(address,prefix,"ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::",3,"ipv6");
for (const [address,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const) excluded.addSubnet(address,prefix,"ipv6");
export function isPublicImageAddress(address: string) {
  const family=isIP(address);
  return family===4 ? !excluded.check(address,"ipv4") : family===6 && globalV6.check(address,"ipv6") && !excluded.check(address,"ipv6");
}
export function remoteImageURL(value: string): URL | null {
  try {
    if(value.length>2048) return null;
    const url=new URL(value);
    if(url.protocol!=="https:" || (url.port && url.port!=="443") || url.username || url.password || url.hash || isIP(url.hostname.replace(/^\[|\]$/g,"")) || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".") || url.hostname.endsWith(".")) return null;
    return url;
  } catch { return null; }
}

/** Fixed image formats and bounded decoded size; never SVG/HTML or a tracking-sized raster. */
export function rasterType(bytes: Buffer): "image/png" | "image/jpeg" | null {
  let width=0,height=0,type: "image/png" | "image/jpeg" | null=null;
  if(bytes.length>=33 && bytes.subarray(0,8).toString("hex")==="89504e470d0a1a0a" && bytes.toString("ascii",12,16)==="IHDR") {
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);type="image/png";
  } else if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216) {
    let offset=2;
    while(offset+4<=bytes.length) {
      if(bytes[offset]!==255) return null;
      const marker=bytes[offset+1]!;
      if(marker===0xda || marker===0xd9) break;
      const length=bytes.readUInt16BE(offset+2);
      if(length<2 || offset+2+length>bytes.length) return null;
      if([0xc0,0xc1,0xc2].includes(marker) && length>=8) {height=bytes.readUInt16BE(offset+5);width=bytes.readUInt16BE(offset+7);type="image/jpeg";break;}
      offset+=length+2;
    }
  }
  return type && width>2 && height>2 && width<=8192 && height<=8192 && width*height<=16_000_000 ? type : null;
}

type Address = {address:string;family:number};
export type RemoteImageDependencies = { resolve?: (host:string)=>Promise<Address[]>; request?: typeof request };
/** DNS is checked once; this connection cannot resolve a second/rebound address or reuse a pooled socket. */
export async function downloadRemoteImage(url: URL, signal: AbortSignal, dependencies: RemoteImageDependencies = {}): Promise<Buffer> {
  if(!remoteImageURL(url.href)) throw new Error("Image unavailable");
  signal.throwIfAborted();
  let abortDNS: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Address[];
  try {
    addresses = await Promise.race([
      (dependencies.resolve ?? (host=>lookup(host,{all:true})))(url.hostname),
      new Promise<never>((_,reject)=>{
        abortDNS=()=>reject(new Error("Image unavailable"));
        signal.addEventListener("abort",abortDNS,{once:true});
        timer=setTimeout(abortDNS,3000);
        if(signal.aborted)abortDNS();
      }),
    ]);
  } finally {
    if(timer)clearTimeout(timer);
    signal.removeEventListener("abort",abortDNS);
  }
  signal.throwIfAborted();
  if(!addresses.length || addresses.some(a=>!isPublicImageAddress(a.address) || isIP(a.address)!==a.family)) throw new Error("Image unavailable");
  const address=addresses[0]!;
  return await new Promise<Buffer>((resolve,reject)=>{
    const req=(dependencies.request ?? request)(url,{
      method:"GET", agent:false, rejectUnauthorized:true, servername:url.hostname, family:address.family, signal,
      // No cookie, authorization, referrer, or compression headers from the client/mail.
      headers:{Accept:"image/png, image/jpeg", "Accept-Encoding":"identity"},
      lookup:((_host:unknown,options:any,callback:any)=>options?.all ? callback(null,[address]) : callback(null,address.address,address.family)) as any,
    },response=>{
      const mime=String(response.headers["content-type"]??"").split(";")[0]?.trim().toLowerCase();
      if(response.statusCode!==200 || (response.headers["content-encoding"] && response.headers["content-encoding"]!=="identity") || !["image/png","image/jpeg"].includes(mime??"") || Number(response.headers["content-length"])>imageByteLimit) {response.destroy();reject(new Error("Image unavailable"));return;}
      const chunks:Buffer[]=[];let size=0;
      response.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>imageByteLimit){response.destroy();reject(new Error("Image unavailable"));}else chunks.push(chunk);});
      response.on("error",()=>reject(new Error("Image unavailable")));
      response.on("end",()=>{const bytes=Buffer.concat(chunks);if(rasterType(bytes)!==mime)reject(new Error("Image unavailable"));else resolve(bytes);});
    });
    req.setTimeout(4000,()=>req.destroy(new Error("Image unavailable")));
    req.on("error",()=>reject(new Error("Image unavailable")));req.end();
  });
}
