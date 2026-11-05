import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import sharp from "sharp";

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
    if(bytes.readUInt32BE(8)!==13)return null;
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
    const depth=bytes[24]!,colour=bytes[25]!;
    const validDepths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if(!validDepths[colour]?.includes(depth)||bytes[26]!==0||bytes[27]!==0||![0,1].includes(bytes[28]!))return null;
    let offset=8, idat=false, ended=false, first=true;
    while(offset+12<=bytes.length){
      const length=bytes.readUInt32BE(offset), end=offset+12+length;
      if(end>bytes.length)return null;
      const name=bytes.toString("ascii",offset+4,offset+8);
      if((first&&name!=="IHDR")||(!first&&name==="IHDR"))return null;
      if(crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return null;
      if(name==="IDAT")idat=true;
      if(name==="IEND"){if(length!==0||!idat||end!==bytes.length)return null;ended=true;break;}
      first=false;offset=end;
    }
    if(!ended)return null;type="image/png";
  } else if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216) {
    if(bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9)return null;
    let offset=2;
    let scan=false;
    while(offset+4<=bytes.length) {
      if(bytes[offset]!==255) return null;
      const marker=bytes[offset+1]!;
      if(marker===0xd9) break;
      const length=bytes.readUInt16BE(offset+2);
      if(length<2 || offset+2+length>bytes.length) return null;
      if([0xc0,0xc1,0xc2].includes(marker) && length>=8) {height=bytes.readUInt16BE(offset+5);width=bytes.readUInt16BE(offset+7);type="image/jpeg";}
      if(marker===0xda){scan=true;break;}
      offset+=length+2;
    }
    if(!scan)return null;
  }
  return type && width>2 && height>2 && width<=8192 && height<=8192 && width*height<=16_000_000 ? type : null;
}

function crc32(bytes:Buffer) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}

/** Fully decode within a fixed pixel budget; headers and CRC alone cannot validate image data. */
let decodeTail:Promise<void>=Promise.resolve();
export async function validatedRasterType(bytes:Buffer,signal?:AbortSignal):Promise<"image/png"|"image/jpeg"|null> {
  const type=rasterType(bytes);
  if(!type || bytes.length>=imageByteLimit)return null;
  const previous=decodeTail;
  let release!:()=>void;
  decodeTail=new Promise<void>(resolve=>{release=resolve;});
  const work=previous.then(async()=>{
    try {
      if(signal?.aborted)return null;
      const decoder=sharp(bytes,{failOn:"warning",limitInputPixels:16_000_000,sequentialRead:true});
      const meta=await decoder.metadata();
      if(signal?.aborted || (meta.pages??1)!==1 || (type==="image/png"?meta.format!=="png":meta.format!=="jpeg"))return null;
      const result=await decoder.raw().toBuffer({resolveWithObject:true});
      const {width,height,channels}=result.info;
      if(signal?.aborted||width<=2||height<=2||width>8192||height>8192||width*height>16_000_000||channels>4||result.data.length>64_000_000)return null;
      return type;
    } catch { return null; }
  }).finally(release);
  if(!signal)return work;
  return await new Promise(resolve=>{
    const abort=()=>{signal.removeEventListener("abort",abort);resolve(null);};
    signal.addEventListener("abort",abort,{once:true});
    work.then(result=>{signal.removeEventListener("abort",abort);resolve(result);});
    if(signal.aborted)abort();
  });
}

type Address = {address:string;family:number};
export type ImageFailureReason = "dns" | "destination" | "network" | "response" | "size" | "raster" | "cancelled";
export class ImageFetchError extends Error {
  constructor(readonly reason:ImageFailureReason, readonly bytes:number=0) { super("Image unavailable"); }
}
export type RemoteImageDependencies = { resolve?: (host:string)=>Promise<Address[]>; request?: typeof request };
/** DNS is checked once; this connection cannot resolve a second/rebound address or reuse a pooled socket. */
export async function downloadRemoteImage(url: URL, signal: AbortSignal, dependencies: RemoteImageDependencies = {}): Promise<Buffer> {
  if(!remoteImageURL(url.href)) throw new ImageFetchError("destination");
  if(signal.aborted) throw new ImageFetchError("cancelled");
  let abortDNS: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Address[];
  try {
    addresses = await Promise.race([
      (dependencies.resolve ?? (host=>lookup(host,{all:true})))(url.hostname),
      new Promise<never>((_,reject)=>{
        abortDNS=()=>reject(new ImageFetchError(signal.aborted ? "cancelled" : "dns"));
        signal.addEventListener("abort",abortDNS,{once:true});
        timer=setTimeout(abortDNS,3000);
        if(signal.aborted)abortDNS();
      }),
    ]);
  } catch (error) {
    throw error instanceof ImageFetchError ? error : new ImageFetchError("dns");
  } finally {
    if(timer)clearTimeout(timer);
    signal.removeEventListener("abort",abortDNS);
  }
  if(signal.aborted) throw new ImageFetchError("cancelled");
  if(!addresses.length || addresses.some(a=>!isPublicImageAddress(a.address) || isIP(a.address)!==a.family)) throw new ImageFetchError("destination");
  // Retry only connection failures before any response bytes. Each socket remains pinned.
  addresses=addresses.slice(0,4);
  for(let index=0;index<addresses.length;index++) {
    try { return await downloadPinned(url,signal,addresses[index]!,dependencies.request ?? request); }
    catch(error) {
      if(!(error instanceof ImageFetchError) || error.reason!=="network" || error.bytes!==0 || signal.aborted || index===addresses.length-1) throw error;
    }
  }
  throw new ImageFetchError("network");
}
function downloadPinned(url:URL,signal:AbortSignal,address:Address,send:typeof request):Promise<Buffer> {
  return new Promise<Buffer>((resolve,reject)=>{
    let size=0, responded=false;
    const fail=(reason:ImageFailureReason)=>reject(new ImageFetchError(reason,size));
    const req=send(url,{
      method:"GET", agent:false, rejectUnauthorized:true, servername:url.hostname, family:address.family, signal,
      // No cookie, authorization, referrer, or compression headers from the client/mail.
      headers:{Accept:"image/png, image/jpeg", "Accept-Encoding":"identity"},
      lookup:((_host:unknown,options:any,callback:any)=>options?.all ? callback(null,[address]) : callback(null,address.address,address.family)) as any,
    },response=>{
      responded=true;
      const mime=String(response.headers["content-type"]??"").split(";")[0]?.trim().toLowerCase();
      if(response.statusCode!==200 || (response.headers["content-encoding"] && response.headers["content-encoding"]!=="identity") || !["image/png","image/jpeg"].includes(mime??"")) {response.destroy();fail("response");return;}
      if(Number(response.headers["content-length"])>=imageByteLimit) {response.destroy();fail("size");return;}
      const chunks:Buffer[]=[];
      // Reserve one byte as a sentinel. Reading explicitly avoids accepting a
      // whole oversized stream chunk beyond the per-image allowance.
      response.on("readable",()=>{
        let chunk:Buffer|null;
        while((chunk=response.read(Math.min(64*1024,imageByteLimit-size)))!==null){
          size+=chunk.length;
          if(size>=imageByteLimit){response.destroy();fail("size");return;}
          chunks.push(chunk);
        }
      });
      response.on("error",()=>fail(signal.aborted?"cancelled":"response"));
      response.on("aborted",()=>fail(signal.aborted?"cancelled":"response"));
      response.on("end",()=>{const bytes=Buffer.concat(chunks);void validatedRasterType(bytes,signal).then(type=>{if(type!==mime)fail(signal.aborted?"cancelled":"raster");else resolve(bytes);},()=>fail("raster"));});
    });
    req.setTimeout(4000,()=>req.destroy(new Error("Image unavailable")));
    req.on("error",()=>fail(signal.aborted?"cancelled":responded?"response":"network"));req.end();
  });
}
