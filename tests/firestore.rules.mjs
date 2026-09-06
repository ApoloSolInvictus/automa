import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
test('only owner reads allowed collections; all browser writes and cross-account reads denied', async () => {
 const env = await initializeTestEnvironment({ projectId:'demo-automa',firestore:{rules:await readFile('firestore.rules','utf8'),host:'127.0.0.1',port:8080} });
 try {
  const owner=env.authenticatedContext('owner').firestore(), other=env.authenticatedContext('other').firestore(), guest=env.unauthenticatedContext().firestore();
  for (const name of ['leads','tasks','runs','settings']) {
   const path=`users/owner/${name}/one`;
   await assertSucceeds(getDoc(doc(owner,path)));
   await assertFails(getDoc(doc(other,path)));
   await assertFails(getDoc(doc(guest,path)));
   await assertFails(setDoc(doc(owner,path),{name:'forged'}));
  }
  await assertFails(getDoc(doc(owner,'users/owner/internal/quota')));
 } finally { await env.cleanup(); }
});
