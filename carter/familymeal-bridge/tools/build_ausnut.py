"""Convert FSANZ AUSNUT 2023 spreadsheets into the bridge's compact ausnut.json.

Usage: python3 -I build_ausnut.py <profiles.xlsx> <measures.xlsx> <out.json>
Source: https://www.foodstandards.gov.au/science-data/food-and-nutrient-databases/ausnut/data-files
(CC BY 4.0, Food Standards Australia New Zealand). Values are per 100 g.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsx

prof, meas, out = sys.argv[1:4]
it = xlsx.rows(prof, "Food nutrient profiles")
next(it)
hdr = next(it)
ix = {h: i for i, h in enumerate(hdr)}


def col(*starts):
    for s in starts:
        for h, i in ix.items():
            if h.startswith(s):
                return i
    raise KeyError(starts)


c = dict(id=col("Survey ID"), name=col("Food name"), kj=col("Energy with dietary fibre"),
         protein=col("Protein"), fat=col("Total fat"), carbs=col("Available carbohydrate, with sugar"),
         fibre=col("Total dietary fibre", "Dietary fibre"), sugars=col("Total sugars"), sodium=col("Sodium"))


def num(r, k):
    try:
        return round(float(r[c[k]]), 2)
    except (ValueError, IndexError):
        return 0.0


foods = {}
for r in it:
    if not r or not r[0].isdigit():
        continue
    foods[r[c["id"]]] = {"id": r[c["id"]], "name": r[c["name"]], "kcal": round(num(r, "kj") / 4.184, 1),
                         "protein": num(r, "protein"), "fat": num(r, "fat"), "carbs": num(r, "carbs"),
                         "fibre": num(r, "fibre"), "sugars": num(r, "sugars"), "sodium": num(r, "sodium"),
                         "measures": []}

it = xlsx.rows(meas, "AUSNUT 2023")
next(it)
next(it)
for r in it:
    f = foods.get(r[0])
    if not f:
        continue
    try:
        qty, grams = float(r[4] or 1), float(r[9])
    except ValueError:
        continue
    desc = " ".join(x.strip() for x in r[5:9] if x.strip())
    if desc.startswith("density"):
        f.setdefault("density", round(grams / qty, 4))  # g per ml (first listed form)
    else:
        f["measures"].append([desc, round(grams / qty, 1)])

json.dump(list(foods.values()), open(out, "w"), separators=(",", ":"))
print(len(foods), "foods ->", out, os.path.getsize(out) // 1024, "KB")
