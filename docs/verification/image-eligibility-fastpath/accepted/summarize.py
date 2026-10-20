import json, pathlib, statistics
p=pathlib.Path(__file__).parent
names=['1-baseline','2-candidate','3-candidate','4-baseline']
runs=[json.loads((p/f'{name}.json').read_text()) for name in names]
for key in ['workloads','runtime','parserVersion','sanitizerParserVersion','lockSha256','harnessSha256']:
    assert all(r[key]==runs[0][key] for r in runs),key
assert len({r['revision'] for r in runs if r['role']=='baseline'})==1
assert len({r['revision'] for r in runs if r['role']=='candidate'})==1
assert all(len(r['rows'])==84 and r['downloadCalls']==0 for r in runs)
summary=[]
for workload in runs[0]['workloads']:
    name=workload['name']
    by_run=[[r for r in run['rows'] if r['workload']==name] for run in runs]
    assert len({r['responseSha256'] for rows in by_run for r in rows})==1,(name,'output changed')
    assert len({r['responseBytes'] for rows in by_run for r in rows})==1
    stats={}
    for role,indices in [('baseline',[0,3]),('candidate',[1,2])]:
        rows=[r for i in indices for r in by_run[i]]
        stats[role]={'samples':len(rows)}
        for metric in ['wallMs','cpuMs','scanMs','scanCalls','scanBytes','providerCalls','providerInputBytes']:
            values=[r[metric] for r in rows]
            stats[role][metric]={'median':statistics.median(values),'range':[min(values),max(values)]}
        stats[role]['rssEndpointRangeMiB']=[min(min(r['rssBefore'],r['rssAfter']) for r in rows)/2**20,max(max(r['rssBefore'],r['rssAfter']) for r in rows)/2**20]
        stats[role]['perProcessWallMedianMs']=[statistics.median(r['wallMs'] for r in by_run[i]) for i in indices]
    ratios=[]
    for bi,ci in [(0,1),(3,2)]:
        assert [(r['pair'],r['label']) for r in by_run[bi]]==[(r['pair'],r['label']) for r in by_run[ci]]
        ratios.append([c['wallMs']/b['wallMs'] for b,c in zip(by_run[bi],by_run[ci])])
    aa=[]
    for rows in by_run:
        aa += [next(r['wallMs'] for r in rows if r['pair']==pair and r['label']=='B')/next(r['wallMs'] for r in rows if r['pair']==pair and r['label']=='A') for pair in range(6)]
    flattened=sum(ratios,[])
    summary.append({**workload,**stats,'pairedCandidateBaselineRatio':{'median':statistics.median(flattened),'range':[min(flattened),max(flattened)],'perOrderMedian':[statistics.median(r) for r in ratios]},'AARepeatRatioRange':[min(aa),max(aa)],'responseSha256':by_run[0][0]['responseSha256'],'responseBytes':by_run[0][0]['responseBytes']})
(p/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for row in summary:
    print(row['name'],'wall',round(row['baseline']['wallMs']['median'],2),'->',round(row['candidate']['wallMs']['median'],2),'ratio',round(row['pairedCandidateBaselineRatio']['median'],3),'providerCalls',row['baseline']['providerCalls']['median'],'->',row['candidate']['providerCalls']['median'])
