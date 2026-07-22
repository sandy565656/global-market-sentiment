#!/usr/bin/env python3
import json, math, statistics, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

UA={'User-Agent':'Mozilla/5.0 market-sentiment-monitor/1.0'}
def chart(symbol, days='3y'):
    url=f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol,safe="")}?range={days}&interval=1d&events=history'
    req=urllib.request.Request(url,headers=UA)
    with urllib.request.urlopen(req,timeout=20) as r: obj=json.load(r)
    res=obj['chart']['result'][0]; q=res['indicators']['quote'][0]; closes=q['close']; vols=q.get('volume',[])
    return [(t,c,vols[i] if i<len(vols) else None) for i,(t,c) in enumerate(zip(res['timestamp'],closes)) if c is not None]
def pct_rank(xs,x):
    ys=[v for v in xs if v is not None and math.isfinite(v)]
    return round(100*sum(v<=x for v in ys)/len(ys),1) if ys else None
def returns(rows):
    c=[x[1] for x in rows]; return [math.log(c[i]/c[i-1]) for i in range(1,len(c)) if c[i-1]>0]
def rolling_rv(rows,w=20):
    rs=returns(rows); out=[]
    for i in range(w-1,len(rs)): out.append(100*statistics.stdev(rs[i-w+1:i+1])*math.sqrt(252))
    return out
def market_iv(primary,fallback,name):
    try:
        rows=chart(primary); vals=[x[1] for x in rows]; cur=vals[-1]; p=pct_rank(vals,cur)
        return {'score':round(p),'rawValue':round(cur,2),'rawUnit':'','percentile':p,'change':round(cur-vals[-2],2),'sourceLabel':name+' · 真实期权IV','history':[round(x,2) for x in vals[-30:]],'insight':f'{name}处于近3年{p:.0f}%分位；分数按本市场自身历史标准化。'}
    except Exception:
        rows=chart(fallback); rv=rolling_rv(rows); cur=rv[-1]; p=pct_rank(rv,cur)
        return {'score':round(p),'rawValue':round(cur,2),'rawUnit':'%','percentile':p,'change':round(cur-rv[-2],2),'sourceLabel':'20日已实现波动率 · 代理','history':[round(x,2) for x in rv[-30:]],'insight':f'官方波动率公开源暂不可用，当前显示20日已实现波动率代理，近3年分位为{p:.0f}%。'}
def a_share():
    syms=['000001.SS','399001.SZ','399006.SZ','000300.SS','000905.SS','000852.SS','000688.SS']
    series={}
    for symbol in syms:
        try:
            rows=chart(symbol)
            if len(rows)>30: series[symbol]=rows
        except Exception:
            pass
    sh=series.get('000001.SS') or series.get('000300.SS') or next(iter(series.values()))
    rv=rolling_rv(sh); volp=pct_rank(rv,rv[-1])
    def ret(rows,n):
        c=[x[1] for x in rows]
        return 100*(c[-1]/c[-1-n]-1)
    r5=[ret(rows,5) for rows in series.values()]
    breadth=100*sum(x<0 for x in r5)/len(r5); down=min(100,max(0,-statistics.mean(r5)*12+35))
    if '000852.SS' in series and '000300.SS' in series:
        small=max(0,min(100,50-(ret(series['000852.SS'],5)-ret(series['000300.SS'],5))*8))
    else:
        small=50
    closes=[x[1] for x in sh]; dd=100*(max(closes[-60:])-closes[-1])/max(closes[-60:]); draw=min(100,dd*8)
    vols=[x[2] for x in sh if x[2]]; vratio=vols[-1]/statistics.mean(vols[-21:-1]) if len(vols)>21 else 1; volume=min(100,max(0,50+(vratio-1)*70))
    score=round(.30*volp+.20*breadth+.15*down+.10*small+.10*volume+.10*draw+.05*50)
    return {'score':score,'rawValue':round(rv[-1],2),'rawUnit':'%','percentile':volp,'change':round(rv[-1]-rv[-2],2),'sourceLabel':'A股多因子压力代理','history':[round(x,2) for x in rv[-30:]],'insight':f'上证20日已实现波动率处于近3年{volp:.0f}%分位；主要指数5日下跌占比为{breadth:.0f}%。'}
def main():
    out={'generatedAt':datetime.now(timezone.utc).isoformat(),'markets':{}}
    tasks={'us':('^VIX','^GSPC','VIX'),'hk':('^VHSI','^HSI','VHSI'),'jp':('^JNIV','^N225','Nikkei 225 VI'),'kr':('^VKOSPI','^KS11','VKOSPI')}
    for k,args in tasks.items():
        try: out['markets'][k]=market_iv(*args)
        except Exception as e: out['markets'][k]={'score':None,'rawValue':None,'percentile':None,'sourceLabel':'数据暂不可用','history':[],'insight':'自动数据源本轮未返回有效结果。'}
    try: out['markets']['cn']=a_share()
    except Exception: out['markets']['cn']={'score':None,'rawValue':None,'percentile':None,'sourceLabel':'数据暂不可用','history':[],'insight':'自动数据源本轮未返回有效结果。'}
    Path('data').mkdir(exist_ok=True); Path('data/sentiment.json').write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
if __name__=='__main__': main()
