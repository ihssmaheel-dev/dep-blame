import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createTestRepo} from './helpers/git-fixture.js';
import {getRepoRemoteInfo} from '../packages/core/dist/git/repo.js';
import {createForgeDirectory, configureRemote, hostingInfo, isPublicAddress, requestBytes} from '../packages/core/ui/forge.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N8sAAAAASUVORK5CYII=', 'base64');
const json = value => ({status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(value))});

test('forge: remote links preserve HTTP ports, nested namespaces, SSH web links, and no-remote state', async () => {
  const repo = await createTestRepo();
  try {
    assert.equal(hostingInfo(await getRepoRemoteInfo(repo.repoDir)).provider, 'local');
    await repo.runGit(['config','remote.origin.url','http://localhost:8080/team/sub/project.git']);
    const info = await getRepoRemoteInfo(repo.repoDir);
    assert.equal(info.remoteUrl, 'http://localhost:8080/team/sub/project');
    assert.equal(info.repoPath, 'team/sub/project');
    assert.equal(hostingInfo(info).host, 'localhost:8080');
    assert.equal(hostingInfo(info).provider, 'unknown');
    await repo.runGit(['config','remote.origin.url','ssh://git@git.example:2222/team/project.git']);
    assert.equal((await getRepoRemoteInfo(repo.repoDir)).remoteUrl, 'https://git.example/team/project');
    assert.equal(hostingInfo({remoteUrl:'https://codeberg.org/team/project'}).provider, 'forgejo');
    const subpath = configureRemote(info, {DEP_BLAME_FORGE_WEB_URL:'https://code.example/gitlab/team/sub/project', DEP_BLAME_FORGE_BASE_URL:'https://code.example/gitlab'});
    assert.equal(subpath.repoPath,'team/sub/project');
    assert.equal(subpath.baseUrl,'https://code.example/gitlab');
    assert.throws(()=>configureRemote(info,{DEP_BLAME_FORGE_WEB_URL:'https://secret:token@code.example/a/b'}),/Invalid/);
    assert.equal(hostingInfo({remoteUrl:'https://code.example/scm/TEAM/project'},'bitbucket-server').url,'https://code.example/projects/TEAM/repos/project');
  } finally { repo.cleanup(); }
});

test('forge: all supported providers resolve host-linked authors and proxy raster avatars', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies:{alpha:'1'}}, 'add');
    const sha = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    for (const provider of ['github','gitlab','gitea','forgejo','bitbucket','bitbucket-server']) {
      const origin = provider === 'bitbucket' ? 'https://bitbucket.org' : 'https://forge.example';
      const remote = {remoteUrl:origin + '/team/project', repoPath:'team/project'};
      let calls = 0;
      const directory = createForgeDirectory(repo.repoDir, {env:{DEP_BLAME_FORGE_PROVIDER:provider}, request:async (url, options) => {
        calls++;
        if (url.includes('/avatars/') || url.includes('/avatar.png')) return {status:200,headers:{},bytes:PNG};
        if (provider === 'gitlab') {
          const body = JSON.parse(options.body); assert.equal(body.variables.ref,sha); assert.equal(body.variables.path,'team/project');
          return json({data:{project:{repository:{commit:{author:{username:'account',webUrl:origin+'/account',avatarUrl:origin+'/avatars/account.png'}}}}}});
        }
        if (provider === 'bitbucket') return json({author:{user:{account_id:'id',nickname:'account',links:{html:{href:origin+'/account'},avatar:{href:origin+'/avatars/account.png'}}}}});
        if (provider === 'bitbucket-server') return json({author:{id:42,slug:'account',name:'Account'}});
        return json({author:{id:42,login:'account',html_url:origin+'/account',avatar_url:origin+'/avatars/account.png'}});
      }});
      directory.setRepository(remote,[{commitFull:sha}]);
      const value = await directory.resolve([sha]);
      assert.equal(value.hosting.provider,provider);
      const profile = value.profiles[sha];
      assert.ok(profile.username);
      assert.match(profile.avatarUrl,/^\/api\/avatars\/[a-f0-9]{64}$/);
      assert.equal(directory.getAvatar(profile.avatarUrl.split('/').pop()).type,'image/png');
      assert.ok(!('email' in profile));
      assert.ok(!JSON.stringify(value).includes('test@runner.local'));
      await directory.resolve([sha]); assert.equal(calls,2,'profile and avatar should be cached');
      await assert.rejects(directory.resolve(['a'.repeat(40)]), /Invalid history/);
    }
  } finally { repo.cleanup(); }
});

test('forge: self-hosted profile and repository links preserve installation subpaths', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json', {dependencies:{alpha:'1'}}, 'add');
    const sha = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    for (const provider of ['gitea', 'bitbucket-server']) {
      const base = 'https://forge.example/git';
      const env = {DEP_BLAME_FORGE_PROVIDER:provider, DEP_BLAME_FORGE_BASE_URL:base,
        DEP_BLAME_FORGE_WEB_URL:base + (provider === 'gitea' ? '/team/project' : '/projects/TEAM/repos/project')};
      const calls = [];
      const directory = createForgeDirectory(repo.repoDir, {env, request:async url => {
        calls.push(url);
        if (url.includes('/avatar.png')) return {status:200, headers:{}, bytes:PNG};
        return json({author:provider === 'gitea' ? {id:42,login:'account'} : {id:42,slug:'account',name:'Account'}});
      }});
      const remote = configureRemote({remoteUrl:base + '/team/project'}, env);
      directory.setRepository(remote, [{commitFull:sha}]);
      const value = await directory.resolve([sha]);
      assert.equal(value.profiles[sha].profileUrl, base + (provider === 'gitea' ? '/account' : '/users/account'));
      assert.ok(calls.every(url => url.startsWith(base + '/')));
      assert.equal(value.hosting.url, env.DEP_BLAME_FORGE_WEB_URL);
    }
    assert.equal(hostingInfo({remoteUrl:'https://forge.example/git/scm/TEAM/project',baseUrl:'https://forge.example/git'}, 'bitbucket-server').url,
      'https://forge.example/git/projects/TEAM/repos/project');
  } finally { repo.cleanup(); }
});

test('forge: names are not account IDs; identical names with different emails stay distinct', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json',{dependencies:{alpha:'1'}},'add');
    const a = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    await repo.commitFile('package.json',{dependencies:{alpha:'2'}},'update');
    const b = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    await repo.runGit(['config','user.email','second@runner.local']);
    await repo.commitFile('package.json',{dependencies:{alpha:'3'}},'other author same name');
    const c = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    let calls = 0;
    const directory = createForgeDirectory(repo.repoDir,{env:{},request:async url => {
      calls++; const username = url.endsWith(c) ? 'second' : 'first';
      return json({author:{id:42,login:username,html_url:'https://github.com/'+username}});
    }});
    directory.setRepository({remoteUrl:'https://github.com/team/project'},[a,b,c].map(commitFull=>({commitFull})));
    const [{profiles}, second] = await Promise.all([directory.resolve([a,b,c]),directory.resolve([a,b,c])]);
    assert.equal(calls,2,'one lookup per distinct Git identity, single-flight across requests');
    assert.equal(profiles[a].username,'first'); assert.equal(profiles[b].username,'first');
    assert.equal(profiles[c].username,'second'); assert.equal(second.profiles[c].username,'second');
    const unmatched = createForgeDirectory(repo.repoDir,{env:{},request:async()=>json({author:null})});
    unmatched.setRepository({remoteUrl:'https://github.com/team/project'},[{commitFull:a}]);
    assert.equal((await unmatched.resolve([a])).profiles[a],null);
  } finally { repo.cleanup(); }
});

test('forge: detects a self-hosted service through its API without guessing the hostname', async () => {
  const repo = await createTestRepo();
  try {
    await repo.commitFile('package.json',{dependencies:{alpha:'1'}},'add');
    const sha = (await repo.runGit(['rev-parse','HEAD'])).stdout.trim();
    for (const provider of ['gitlab','gitea','forgejo','github','bitbucket-server']) {
      const directory = createForgeDirectory(repo.repoDir,{env:{},request:async url => {
        if (url.endsWith('/api/v1/version') && ['gitea','forgejo'].includes(provider)) return json({version:'1.0'});
        if (url.endsWith('/api/forgejo/v1/version') && provider === 'forgejo') return json({version:'1.0'});
        if (url.endsWith('/api/graphql') && provider === 'gitlab') return json({data:{project:null}});
        if (url.endsWith('/api/v3/meta') && provider === 'github') return json({installed_version:'3.0'});
        if (url.endsWith('/application-properties') && provider === 'bitbucket-server') return json({version:'9.0',buildNumber:'42'});
        throw new Error('unavailable');
      }});
      directory.setRepository({remoteUrl:'https://code.example/team/project'},[{commitFull:sha}]);
      assert.equal((await directory.resolve([sha])).hosting.provider,provider);
      directory.setRepository({remoteUrl:'https://code.example/team/project'},[{commitFull:sha}]);
      assert.equal(directory.getHosting().provider,provider,'warm scans must retain detection');
    }
  } finally { repo.cleanup(); }
});

test('forge: private destinations, oversized images, unsafe tokens and redirects are constrained', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','2001:db8::1','2001:0db8::1','2001::1','3fff::1']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  const server = http.createServer((req,res) => {
    if (req.url === '/large') { res.end(Buffer.alloc(100)); return; }
    if (req.url === '/redirect') { res.writeHead(302,{Location:'http://127.0.0.2:1234/'}); res.end(); return; }
    res.end(PNG);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+server.address().port;
  try {
    await assert.rejects(requestBytes(origin),/Private forge/);
    assert.equal((await requestBytes(origin,{privateOrigin:origin})).status,200);
    await assert.rejects(requestBytes(origin+'/large',{privateOrigin:origin,maxBytes:50}),/too large/);
    await assert.rejects(requestBytes(origin,{privateOrigin:origin,token:'test'}),/HTTPS/);
    await assert.rejects(requestBytes(origin+'/redirect',{privateOrigin:origin}),/Private forge/);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('forge: offline mode makes no external requests', async () => {
  const directory = createForgeDirectory('.', {env:{DEP_BLAME_AVATARS:'0'}, request:async()=>{throw new Error('must not be called');}});
  const sha='a'.repeat(40);
  directory.setRepository({remoteUrl:'https://github.com/team/project'},[{commitFull:sha}]);
  assert.deepEqual(Object.keys((await directory.resolve([sha])).profiles),[]);
});
