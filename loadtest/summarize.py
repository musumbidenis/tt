import csv, json, sys
name = sys.argv[1]
print(f"{'request':30} {'count':>7} {'fail':>5} {'median':>7} {'p95':>6} {'p99':>6} {'max':>6} {'req/s':>6}")
for r in csv.DictReader(open(f'{name}_stats.csv')):
    print(f"{(r['Type'] + ' ' + r['Name'])[:30]:30} {r['Request Count']:>7} {r['Failure Count']:>5} {float(r['Median Response Time']):7.0f} {float(r['95%']):6.0f} {float(r['99%']):6.0f} {float(r['Max Response Time']):6.0f} {float(r['Requests/s']):6.2f}")
fails = list(csv.DictReader(open(f'{name}_failures.csv')))
for f in fails[:10]: print('FAIL', f['Name'], f['Occurrences'], f['Error'][:120])
try:
    m = json.load(open(f'{name}.meter.json'))
    tq = sum(v['queries'] for v in m.values()); tr = sum(v['read'] for v in m.values()); tw = sum(v['written'] for v in m.values())
    print(f"\nD1 per request type: queries / rows read / rows written (average, max)")
    for k, v in sorted(m.items(), key=lambda x: -x[1]['read']):
        print(f"  {k:16} n={v['n']:6}  q={v['queries']/v['n']:5.1f}  read={v['read']/v['n']:8.1f} (max {v['maxRead']})  written={v['written']/v['n']:5.1f} (max {v['maxWritten']})")
    print(f"  TOTAL queries={tq} rows read={tr} rows written={tw}")
except FileNotFoundError: pass
