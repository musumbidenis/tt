import json, sys
b = json.load(open(sys.argv[1])); a = json.load(open(sys.argv[2]))
print(f"{'request':12} {'trips before':>12} {'trips after':>11} {'rows read before':>17} {'after':>8} {'written before':>15} {'after':>6}")
for k in sorted(set(a) | set(b), key=lambda k: -(b.get(k, {}).get('n', 0))):
    x, y = b.get(k), a.get(k)
    if not x or not y: continue
    print(f"{k:12} {x['queries']/x['n']:12.1f} {y['trips']/y['n']:11.1f} {x['read']/x['n']:17.1f} {y['read']/y['n']:8.1f} {x['written']/x['n']:15.1f} {y['written']/y['n']:6.1f}")
