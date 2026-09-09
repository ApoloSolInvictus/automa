import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
test('only owner reads allowed collections; all browser writes and cross-account reads denied', async () => {
 const env = await initializeTestEnvironment({ projectId:'demo-automa',firestore:{rules:await readFile('firestore.rules','utf8'),host:'127.0.0.1',port:8080} });
 try {
  const owner=env.authenticatedContext('owner').firestore(), other=env.authenticatedContext('other').firestore(), guest=env.unauthenticatedContext().firestore();
  await env.withSecurityRulesDisabled(async context => {
   const admin = context.firestore();
   await setDoc(doc(admin, 'organizations/acme/members/owner'), { role:'owner' });
   await setDoc(doc(admin, 'organizations/acme/companies/company'), { name:'Acme' });
   await setDoc(doc(admin, 'organizations/acme/leads/lead'), { name:'Lead' });
  });
  await assertSucceeds(getDoc(doc(owner, 'organizations/acme/companies/company')));
  await assertSucceeds(getDoc(doc(owner, 'organizations/acme/leads/lead')));
  await assertFails(getDoc(doc(other, 'organizations/acme/companies/company')));
  await assertFails(getDoc(doc(guest, 'organizations/acme/companies/company')));
  await assertFails(setDoc(doc(owner, 'organizations/acme/companies/company'), { name:'forged' }));
  for (const name of ['leads','tasks','runs','settings','agents','automations','integrations','companies','contacts','opportunities','activities']) {
   const path=`users/owner/${name}/one`;
   await assertSucceeds(getDoc(doc(owner,path)));
   await assertFails(getDoc(doc(other,path)));
   await assertFails(getDoc(doc(guest,path)));
   await assertFails(setDoc(doc(owner,path),{name:'forged'}));
  }
  await assertFails(getDoc(doc(owner,'users/owner/internal/quota')));
  await assertFails(getDoc(doc(owner,'users/owner/private/gmail')));
 } finally { await env.cleanup(); }
});
