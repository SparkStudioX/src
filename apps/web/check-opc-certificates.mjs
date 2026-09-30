import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync(new URL('src/opcCertificateModel.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {normalizeFingerprint,certificateListing,publicDerBytes,preparePublicCertificate,certificateTrustRequest,certificateRemovalRequest,publicCertificatePath}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
let count=0; const check=async(name,run)=>{await run();count++;console.log(`PASS ${name}`);};
// Synthetic envelope is deliberately not a real certificate. Server X.509/strength checks remain authoritative.
const der = new Uint8Array([0x30,30,0x30,10,...Array(10).fill(1),0x30,4,1,2,3,4,0x03,10,...Array(10).fill(2)]);
const sha='A'.repeat(64),cert={store:'trusted',sha256:sha,subject:'CN=Synthetic',issuer:'CN=Synthetic',notBefore:'2026-01-01T00:00:00Z',notAfter:'2027-01-01T00:00:00Z'};
await check('fingerprints accept exact hexadecimal bytes with display separators only',()=>{
  assert.equal(normalizeFingerprint('aa:'.repeat(31)+'aa'),sha); assert.equal(normalizeFingerprint(' aa '.repeat(32)),sha);
  for(const value of ['A'.repeat(63),'G'.repeat(64),'../'+sha,'SHA256='+sha]) assert.throws(()=>normalizeFingerprint(value));
});
await check('public certificate paths cannot address private keys or arbitrary directories',()=>{
  assert.equal(publicCertificatePath(cert),'/gateway/opcua/certificates/trusted/'+sha);
  for(const store of ['private','own/private','../own','unknown']) assert.throws(()=>publicCertificatePath({...cert,store}));
  assert.throws(()=>publicCertificatePath({...cert,sha256:'../private'}));
});
await check('DER validation rejects keys, PEM, containers, trailing data and oversize files',()=>{
  publicDerBytes('certificate.der',der);
  const key=der.slice();key[2]=0x02;
  for(const [name,bytes] of [['key.der',key],['certificate.pem',der],['key.pfx',der],['certificate.cer',new TextEncoder().encode(['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('')+'a'.repeat(50))],['certificate.der',new Uint8Array([...der,1])],['certificate.der',new Uint8Array(65537)]]) assert.throws(()=>publicDerBytes(name,bytes));
});
await check('browser fingerprint hashes exact DER bytes and produces public-only base64',async()=>{
  const file={name:'synthetic.cer',size:der.length,arrayBuffer:async()=>der.buffer};const upload=await preparePublicCertificate(file);
  assert.equal(upload.sha256,createHash('sha256').update(der).digest('hex').toUpperCase());assert.equal(upload.certificate,Buffer.from(der).toString('base64'));assert.equal(upload.bytes,der.length);
});
await check('trust requires independent verification and an exact fingerprint match',()=>{
  const upload={name:'synthetic.der',bytes:der.length,certificate:Buffer.from(der).toString('base64'),sha256:sha};
  assert.throws(()=>certificateTrustRequest(upload,sha,false));assert.throws(()=>certificateTrustRequest(upload,'B'.repeat(64),true));
  assert.deepEqual(certificateTrustRequest(upload,sha.toLowerCase(),true),{certificate:upload.certificate,confirmedSha256:sha});
});
await check('removal requires exact confirmed fingerprint and cannot remove the own certificate',()=>{
  assert.deepEqual(certificateRemovalRequest(cert,sha),{confirmedSha256:sha});assert.throws(()=>certificateRemovalRequest(cert,'B'.repeat(64)));assert.throws(()=>certificateRemovalRequest({...cert,store:'own'},sha));
});
await check('list payload validation rejects malformed dates, stores and unsafe fingerprint addresses',()=>{
  assert.equal(certificateListing({certificates:[cert],invalidFiles:0,note:'Public only'}).certificates[0],cert);
  for(const patch of [{store:'private'},{sha256:'../private'},{notAfter:'not-a-date'}])assert.throws(()=>certificateListing({certificates:[{...cert,...patch}],invalidFiles:0,note:'Public only'}));
});
console.log(`${count}/${count} OPC public certificate checks passed.`);
