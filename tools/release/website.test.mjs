import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const html=fs.readFileSync(path.join(root,'website/public/index.html'),'utf8');
// The site advertises the released version, while the app may be preparing a
// newer candidate. Never require public links to unpublished assets.
const release=html.match(/data-version>(\d+\.\d+\.\d+)</)?.[1];
test('website download links agree with its published version and disclose unnotarized manual installation',()=>{
  assert.ok(release);
  const links=[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
  const downloads=links.filter(s=>/releases\/download\//.test(s));
  assert.equal(downloads.length,2);
  for(const url of downloads){
    assert.ok(url.startsWith(`https://github.com/liyunhui0707/session-manager/releases/download/v${release}/AI-Session-Manager-${release}-mac-arm64.`));
  }
  assert.match(html,/未使用 Apple Developer ID 签名，也未公证/);assert.match(html,/尚不提供应用内自动安装/);
});
test('local assets and anchors resolve; website does not add external script or font loading',()=>{
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const [,url] of html.matchAll(/(?:src|href)="([^"]+)"/g)){
    if(url.startsWith('#')){if(url.length>1)assert.ok(ids.has(url.slice(1)),url);continue;}
    if(/^https:\/\//.test(url))continue;
    assert.ok(fs.statSync(path.join(root,'website/public',url)).isFile(),url);
  }
  assert.doesNotMatch(html,/<script[^>]+src="https?:/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'website/public/style.css'),'utf8'),/@import|https?:\/\//);
});
