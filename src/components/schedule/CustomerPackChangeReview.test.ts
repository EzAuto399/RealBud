import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {CustomerPackChangeReview} from './CustomerPackChangeReview';
import type {CustomerPackChangePreview,CustomerPackRecipe} from '@shared/customer-packs';
const recipe:CustomerPackRecipe={id:'wf-fixture',title:'Review the inbox',description:'Preserve the source.',steps:['Check the message.'],evidence:'Source links.',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,schedule:null,allowedOrigins:[]};
const preview:CustomerPackChangePreview={action:'upgrade',pack:{format:'realbud-customer-pack',version:1,id:'fixture-office',title:'Fictional office',revision:2,
  workflows:[{id:'inbox',title:'Review inbox',recipeIds:[recipe.id],checks:['input-coverage']}],recipes:[recipe],skills:[],dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}},digest:'a'.repeat(64),installedDigest:'b'.repeat(64),installedRevision:1,previewDigest:'c'.repeat(64),
  recipes:[{id:recipe.id,action:'update',before:recipe,after:{...recipe,description:'Check verified source dates.'}}],skills:[],instructions:[{key:'guidance:fixture',before:'Old text\n  Preserve spaces.',after:'<script>fictional literal text</script>\n  Keep indentation.'}],conflicts:[],canApply:true};
describe('plain-language pack change review',()=>{
  it('renders readable plans and escaped literal instruction changes with approval initially disabled',()=>{
    const html=renderToStaticMarkup(createElement(CustomerPackChangeReview,{preview,busy:false,apply:()=>{},cancel:()=>{}}));
    expect(html).toContain('Read workroom files');expect(html).toContain('Up to 2 minutes and 6 assistant steps.');expect(html).toContain('Permitted websites');
    expect(html).toContain('Check the message.');expect(html).toContain('require fresh approval');expect(html).not.toContain('&quot;maxRuntimeMinutes&quot;');
    expect(html).toContain('&lt;script&gt;fictional literal text&lt;/script&gt;');expect(html).toContain('\n  Keep indentation.');expect(html).not.toContain('<script>');
    expect(html).toMatch(/disabled=""[^>]*>Apply reviewed upgrade/);expect(html).toContain('I reviewed this exact change');
  });
  it('keeps conflicts visible and prevents confirmation while a change is unavailable',()=>{
    const html=renderToStaticMarkup(createElement(CustomerPackChangeReview,{preview:{...preview,canApply:false,conflicts:['Your local steps conflict with this version.']},busy:false,apply:()=>{},cancel:()=>{}}));
    expect(html).toContain('Your local steps conflict with this version.');expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  });
});
