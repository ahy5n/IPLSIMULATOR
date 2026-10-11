#!/usr/bin/env python3
"""Build scenario JSON from the BCCI auction lists and Wikipedia.

Usage:
  python3 tools/build_data.py                  # rebuild every scenario from cached sources in tools/raw/
  python3 tools/build_data.py --fetch          # re-download sources first, then rebuild
  python3 tools/build_data.py --fetch-wiki     # refresh only Wikipedia sources; restore them if the rebuild fails
  python3 tools/build_data.py --only ipl-2025  # one scenario
  python3 tools/build_data.py --check-new      # exit 0 and print the year if a newer season's
                                               # retentions page exists (used by the scheduled update)
  python3 tools/build_data.py --retentions 2027   # write data/scenarios/ipl-2027/retentions.json

Sources per scenario (see SCENARIOS below)
  * The BCCI auction list PDF (players, sets, reserve prices, caps). Original links on documents.iplt20.com
    stop working after the auction, so --fetch uses Wayback Machine copies. Text extraction uses macOS PDFKit
    when available, otherwise poppler's pdftotext (install poppler-utils on Linux).
  * Wikipedia "List of <year> Indian Premier League personnel changes" (raw wikitext) for retained squads,
    RTM buys and actual auction results.
  * tools/curated_ratings.txt (skill ratings), tools/batting_positions.txt (batting bands),
    retained players' birth dates from Wikidata plus tools/retained_dob_overrides.txt.

Output: data/scenarios/<id>/{meta,players,teams,pool,actual}.json
"""
import hashlib, json, math, os, re, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI_URL = 'https://en.wikipedia.org/w/index.php?title=List_of_{year}_Indian_Premier_League_personnel_changes&action=raw'

SCENARIOS = {
    'ipl-2026': dict(
        year=2026, kind='mini', cap=12500, date=(2025, 12, 16), venue='Abu Dhabi',
        main_sets={'full': 10, 'quick': 5},   # sets called before the accelerated rounds
        champion='RCB', runner_up='PBKS',     # IPL 2025 final: the champions host the 2026 opener
        pdf='https://web.archive.org/web/2025id_/https://documents.iplt20.com/bcci/documents/1765197869375_TATA-IPL-2026-Auction-List-8.12.25.pdf',
        # Purse remaining before the auction, in lakh, as announced by the IPL on 15 Nov 2025.
        purse={'CSK': 4340, 'DC': 2180, 'GT': 1290, 'KKR': 6430, 'LSG': 2295, 'MI': 275, 'PBKS': 1150, 'RR': 1605, 'RCB': 1640, 'SRH': 2550},
        rtm=None,
    ),
    'ipl-2025': dict(
        year=2025, kind='mega', cap=12000, date=(2024, 11, 24), venue='Jeddah',
        main_sets={'full': 17, 'quick': 9},   # the real auction went to accelerated rounds after lot 116
        champion='KKR', runner_up='SRH',      # IPL 2024 final
        pdf='https://web.archive.org/web/2024id_/https://documents.iplt20.com/bcci/documents/1731674068078_TATA%20IPL%202025-%20Auction%20List%20-15.11.24.pdf',
        # Purse left after retentions (₹120 Cr minus retention slabs), as announced on 31 Oct 2024.
        purse={'CSK': 5500, 'DC': 7300, 'GT': 6900, 'KKR': 5100, 'LSG': 6900, 'MI': 4500, 'PBKS': 11050, 'RR': 4100, 'RCB': 8300, 'SRH': 4500},
        # Right-to-match cards: six minus the number of players retained.
        rtm={'CSK': 1, 'DC': 2, 'GT': 1, 'KKR': 0, 'LSG': 1, 'MI': 1, 'PBKS': 4, 'RR': 0, 'RCB': 3, 'SRH': 1},
    ),
}

TEAMS = [
    # id, full name, primary, secondary, home ground, group
    ('CSK', 'Chennai Super Kings', '#F9CD05', '#0B4EA2', 'Chepauk, Chennai', 'A'),
    ('KKR', 'Kolkata Knight Riders', '#3A225D', '#D4AF37', 'Eden Gardens, Kolkata', 'A'),
    ('RR', 'Rajasthan Royals', '#EA1A85', '#254AA5', 'Sawai Mansingh, Jaipur', 'A'),
    ('RCB', 'Royal Challengers Bengaluru', '#D11D26', '#1C1C1C', 'Chinnaswamy, Bengaluru', 'A'),
    ('PBKS', 'Punjab Kings', '#DD1F2D', '#A7A9AC', 'Mullanpur, New Chandigarh', 'A'),
    ('MI', 'Mumbai Indians', '#004BA0', '#D1AB3E', 'Wankhede, Mumbai', 'B'),
    ('SRH', 'Sunrisers Hyderabad', '#F26522', '#1B1B1B', 'Rajiv Gandhi Intl, Hyderabad', 'B'),
    ('GT', 'Gujarat Titans', '#1B2133', '#B8A26A', 'Narendra Modi Stadium, Ahmedabad', 'B'),
    ('DC', 'Delhi Capitals', '#17479E', '#EF1B23', 'Arun Jaitley, Delhi', 'B'),
    ('LSG', 'Lucknow Super Giants', '#0057E2', '#F28B00', 'Ekana, Lucknow', 'B'),
]
WIKI_TEAMS = {name: tid for tid, name, *_ in TEAMS}
NAT = {'IND': 'India', 'AUS': 'Australia', 'ENG': 'England', 'SA': 'South Africa', 'NZ': 'New Zealand',
       'WIN': 'West Indies', 'SL': 'Sri Lanka', 'AFG': 'Afghanistan', 'BAN': 'Bangladesh'}
COUNTRIES = ['India', 'New Zealand', 'South Africa', 'West Indies', 'Sri Lanka', 'England', 'Australia',
             'Afghanistan', 'Bangladesh', 'Zimbabwe', 'Ireland', 'Scotland', 'Netherlands', 'USA',
             'Nepal', 'Namibia', 'UAE', 'Malaysia', 'Italy', 'Canada', 'Oman']
ROLE = {'BATTER': 'BAT', 'WICKETKEEPER': 'WK', 'ALL-ROUNDER': 'AR', 'BOWLER': 'BOWL'}
# The BCCI lists spell some names differently from year to year. Map them to one name so a player
# keeps the same id, rating and batting bands in every scenario.
ALIASES = {
    'Syed Khaleel Ahmed': 'Khaleel Ahmed', 'Ravichandaran Ashwin': 'Ravichandran Ashwin', 'Mujeeb Ur Rahman': 'Mujeeb Rahman',
    'Mohammad Siraj': 'Mohammed Siraj', 'Mohammad Shami': 'Mohammed Shami', 'Jake Fraser-Mcgurk': 'Jake Fraser-McGurk',
    "William O'Rourke": 'William Orourke', 'Shahbaz Ahamad': 'Shahbaz Ahmed', 'Dan Lawrence': 'Daniel Lawrence',
    'Benjamin Sears': 'Ben Sears', 'R. Sai Kishore': 'Sai Kishore', 'K.S Bharat': 'K.S. Bharat', 'Vyshak Vijaykumar': 'Vijaykumar Vyshak',
    'Gurnoor Singh Brar': 'Gurnoor Brar', 'M. Siddharth': 'Manimaran Siddharth', 'Mohd. Arshad Khan': 'Arshad Khan',
    'Yudhvir Charak': 'Yudhvir Singh', 'Mayank Agarawal': 'Mayank Agarwal',
}


def http_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'IPLAuctionSimBuild/1.0 (data build script)'})
    return urllib.request.urlopen(req, timeout=120).read()


def pdf_rows(pdf):
    """One line of text per table row. PDFKit on macOS (scanning 1pt bands), else pdftotext -layout."""
    if sys.platform == 'darwin':
        js = ('ObjC.import("PDFKit");var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath("%s"));var o=[];'
              'for(var i=0;i<d.pageCount;i++){var p=d.pageAtIndex(i),b=p.boundsForBox(0),W=b.size.width,H=b.size.height,pr="";'
              'for(var y=H;y>0;y-=1){var s=p.selectionForRect($.NSMakeRect(0,y-1,W,1));'
              'var t=s.isNil()?"":(s.string.isNil()?"":s.string.js);t=t.replace(/\\s+/g," ").trim();'
              'if(t&&t!=pr){o.push(i+"|"+Math.round(y)+"|"+t);pr=t;}}}o.join("\\n")') % pdf
        return subprocess.run(['osascript', '-l', 'JavaScript', '-e', js], capture_output=True, text=True, check=True).stdout
    out = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, check=True).stdout
    return '\n'.join('0|0|' + re.sub(r'\s+', ' ', l).strip() for l in out.splitlines() if l.strip())


def fetch(sid, cfg):
    raw = os.path.join(ROOT, 'tools', 'raw', sid)
    os.makedirs(raw, exist_ok=True)
    open(os.path.join(raw, 'pc.wiki'), 'wb').write(http_get(WIKI_URL.format(year=cfg['year'])))
    pdf = os.path.join(raw, 'auction-list.pdf')
    open(pdf, 'wb').write(http_get(cfg['pdf']))
    open(os.path.join(raw, 'rows.txt'), 'w').write(pdf_rows(pdf))


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def jitter(name, spread):
    h = int(hashlib.md5(name.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return (h * 2 - 1) * spread


def bowl_type(style):
    if not style:
        return None
    return 'spin' if re.search(r'Spin|Orthodox|Unorthodox', style) else 'pace'


def parse_pool(raw):
    out, bad = [], []
    lines = open(os.path.join(raw, 'rows.txt')).read().splitlines()
    late = os.path.join(raw, 'late_additions.txt')
    if os.path.exists(late):
        lines += [l for l in open(late).read().splitlines() if l and not l.startswith('#')]
    for line in lines:
        _, _, txt = line.rstrip('\n').split('|', 2)
        m = re.match(r'(\d+) (\d+) ([A-Z]{1,4}\d+) (.*)$', txt)
        if not m:
            continue
        no, setn, code, body = m.groups()
        hit = None
        for c in sorted(COUNTRIES, key=len, reverse=True):
            mm = re.search(r' %s (?:[A-Z]{2,6} )?\d\d/\d\d/\d{4}' % re.escape(c), ' ' + body)
            if mm and (hit is None or mm.start() < hit[1]):
                hit = (c, mm.start())
        if not hit:
            raise ValueError('No country in row: ' + txt)
        country, ci = hit
        name = (' ' + body)[:ci].strip()
        name = ALIASES.get(name, name)
        rest = (' ' + body)[ci + len(country) + 1:].strip()
        rest = re.sub(r' (Mi|Kkr|Csk|Rcb|Srh|Dc|Gt|Lsg|Rr|Pbks) ', lambda m: ' ' + m.group(1).upper() + ' ', rest)  # typos in the BCCI list
        rest = re.sub(r'\b([A-Z]{2,5})[,.]+ ?(?=[A-Z]{2,5}\b)', r'\1,', rest)   # "GT, KKR", "MI,,KKR" -> "GT,KKR"
        # 2026 rows: ... caps [2025 team] [2025 games] status price surname
        # 2025 rows: ... caps [previous teams, e.g. MI,RR] [2024 team] [2024 games] status price
        r = re.match(r'(?:([A-Z]{2,6}) )?(\d\d/\d\d/\d{4}) (\d+) (BATTER|ALL-ROUNDER|WICKETKEEPER|BOWLER) (RHB|LHB)'
                     r'(?: ((?:RIGHT|LEFT) ARM [A-Za-z ]+?))?((?: \d+)*)(?: ([A-Z]{2,5}(?:[,.][A-Z]{2,5})*))?(?: ([A-Z]{2,4}))?(?: (\d+))? '
                     r'(Capped|Uncapped|Associate) (\d+)(?: (.*))?$', rest)
        if not r:
            bad.append(txt)
            continue
        _, dob, age, spec, bat, bowl, nums, prev, team, _, status, price, _ = r.groups()
        if not team and prev and not re.search(r'[,.]', prev):
            team = prev
        out.append(dict(lot=int(no), set=int(setn), setCode=code, name=name, country=country, age=int(age),
                        role=ROLE[spec], batHand=bat, bowlStyle=(bowl or '').strip().title(),
                        caps=[int(x) for x in nums.split()], prevTeam=team, capped=status == 'Capped', base=int(price)))
    if bad:
        raise ValueError('Unparsed rows:\n' + '\n'.join(bad))
    return out


def money(s):
    m = re.search(r'INRConvert\|([\d.]+)\|(c|l)', s)
    if not m:
        return None
    v = float(m.group(1))
    return round(v * 100) if m.group(2) == 'c' else round(v)


def wiki_name(s):
    m = re.search(r'\{\{sortname\|([^|}]*)\|([^|}]*)', s)
    return (m.group(1) + ' ' + m.group(2)).strip() if m else None


def parse_wiki(raw):
    w = open(os.path.join(raw, 'pc.wiki')).read()
    sec = w[w.find('=== Retained players ==='):w.find('== Auction ==')]
    retained = {}
    for tbl in re.split(r'\{\|', sec)[1:]:
        cap = re.search(r'\|\+.*?\[\[([^|\]]+)', tbl)
        if not cap or cap.group(1) not in WIKI_TEAMS:
            continue
        rows = []
        for r in re.split(r'\n\|-', tbl):
            n = wiki_name(r)
            if n:
                nat = re.search(r'\{\{cr\|([A-Z]+)', r)
                rows.append(dict(name=n, nat=nat.group(1), salary=money(r)))
        retained[WIKI_TEAMS[cap.group(1)]] = rows
    sec = w[w.find('=== Sold players ==='):w.find('== Support staff changes ==')]
    sold = []
    for tbl in re.split(r'\{\|', sec)[1:]:
        for r in re.split(r'\n\|-', tbl):
            n = wiki_name(r)
            if not n:
                continue
            teams = [WIKI_TEAMS[x] for x in re.findall(r'\[\[([^|\]]+)\]\]', r) if x in WIKI_TEAMS]
            nums = re.findall(r'\|\| *(\d+) *', r)
            no = re.match(r'\s*\|\s*(\d+)', r)
            sold.append(dict(lot=int(no.group(1)) if no else None, name=n, team=teams[0], price=int(nums[-1]),
                             rtm='{{dagger}}' in r))
    return retained, sold


def load_curated():
    cur = {}
    for line in open(os.path.join(ROOT, 'tools', 'curated_ratings.txt')):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, role, bt, bat, bowl = line.split('|')
        cur[name] = dict(role=role, bowlType=None if bt == '-' else bt, bat=int(bat), bowl=int(bowl))
    return cur


BASE_ANCHOR = {200: 73, 150: 70, 125: 68, 100: 67, 75: 63, 50: 59, 40: 57, 30: 51}


def rate_from_stats(p):
    """Rating from the auction list's own numbers: reserve price, caps, IPL games and age."""
    r = BASE_ANCHOR.get(p['base'], 51)
    caps = p['caps']
    if p['capped']:
        r += min(4, math.log2(1 + max(caps or [0])) * 0.6)
    else:
        ipl = caps[0] if caps else 0          # uncapped rows only carry an IPL match count
        r += min(8, 2.5 * math.log2(1 + ipl))
        if p['prevTeam']:
            r += 1.5                          # was in last season's IPL squad
    if p['age'] > 34:
        r -= (p['age'] - 34) * 1.2
    r += jitter(p['name'], 3)
    bt = bowl_type(p['bowlStyle'])
    role = p['role']
    if role in ('BAT', 'WK'):
        bat, bowl = r, (18 + jitter(p['name'] + 'b', 6) if bt and role == 'BAT' else 5)
    elif role == 'BOWL':
        bat, bowl = 14 + jitter(p['name'] + 'b', 6), r
    else:
        # Most all-rounders lean one way: the primary skill gets the rating, the other trails it.
        if bt == 'spin' or jitter(p['name'] + 'x', 1) > 0:
            bat, bowl = r - 12 + jitter(p['name'] + 'y', 4), r
        else:
            bat, bowl = r, r - 12 + jitter(p['name'] + 'y', 4)
    return dict(role=role, bowlType=bt, bat=round(bat), bowl=round(bowl))


# Indian retained players with no international cap as of Dec 2025. MS Dhoni counts as uncapped under
# the IPL rule for players retired from international cricket for five years.
UNCAPPED_RETAINED = {
    'MS Dhoni', 'Gurjapneet Singh', 'Mukesh Choudhary', 'Ramakrishna Ghosh', 'Shreyas Gopal', 'Ayush Mhatre', 'Urvil Patel',
    'Abhishek Porel', 'Ashutosh Sharma', 'Sameer Rizvi', 'Madhav Tiwari', 'Ajay Mandal', 'Tripurana Vijay', 'Vipraj Nigam',
    'Rahul Tewatia', 'Shahrukh Khan', 'Arshad Khan', 'Gurnoor Brar', 'Kumar Kushagra', 'Anuj Rawat', 'Manav Suthar', 'Nishant Sindhu',
    'Angkrish Raghuvanshi', 'Vaibhav Arora', 'Anukul Roy', 'Abdul Samad', 'Ayush Badoni', 'Mohsin Khan', 'Manimaran Siddharth',
    'Akash Singh', 'Arjun Tendulkar', 'Arshin Kulkarni', 'Himmat Singh', 'Digvesh Rathi', 'Prince Yadav', 'Naman Dhir', 'Robin Minz',
    'Raj Angad Bawa', 'Ashwani Kumar', 'Raghu Sharma', 'Mayank Markande', 'Shashank Singh', 'Nehal Wadhera', 'Prabhsimran Singh',
    'Priyansh Arya', 'Vijaykumar Vyshak', 'Yash Thakur', 'Harpreet Brar', 'Vishnu Vinod', 'Pyla Avinash', 'Harnoor Pannu',
    'Musheer Khan', 'Suryansh Shedge', 'Shubham Dubey', 'Yudhvir Singh', 'Vaibhav Sooryavanshi', 'Rasikh Salam', 'Yash Dayal',
    'Suyash Sharma', 'Swapnil Singh', 'Abhinandan Singh', 'Zeeshan Ansari', 'Smaran Ravichandran', 'Aniket Verma', 'Harsh Dubey',
    # Uncapped at the 2025 retention deadline (Oct 2024). Sandeep Sharma qualified under the five-year rule.
    'Harshit Rana', 'Ramandeep Singh', 'Sandeep Sharma',
}
BANDS = ('top', 'middle', 'lower', 'tail')
BOWL_TYPES = ('RF', 'RFM', 'RM', 'LF', 'LFM', 'OB', 'LB', 'SLA', 'LWS')


def load_bowling_types():
    out = {}
    for line in open(os.path.join(ROOT, 'tools', 'bowling_types.txt')):
        line = line.strip()
        if line and not line.startswith('#'):
            name, code = line.split('|')
            assert code in BOWL_TYPES, line
            out[name] = code
    return out


BAT_STYLES = ('anchor', 'aggressor', 'slogger', 'finisher', 'spin')
BOWL_ROLES = ('newball', 'death')


def load_pairs(fname, allowed, multi=False):
    out = {}
    for line in open(os.path.join(ROOT, 'tools', fname)):
        line = line.strip()
        if line and not line.startswith('#'):
            name, v = line.split('|')
            vals = v.split(',')
            assert all(x in allowed for x in vals), line
            out[name] = vals if multi else vals[0]
    return out


def type_from_style(style):
    """Bowling type code from a BCCI list style such as 'Left Arm Fast Medium'."""
    s = (style or '').lower()
    if not s:
        return None
    left = s.startswith('left')
    if 'unorthodox' in s:
        return 'LWS'
    if 'orthodox' in s:
        return 'SLA'
    if 'leg' in s:
        return 'LB'
    if 'off' in s:
        return 'OB'
    if left:
        return 'LF' if s.endswith('fast') else 'LFM'
    if 'medium' in s and 'fast' not in s:
        return 'RM'
    return 'RF' if s.endswith('fast') else 'RFM'


def bowling_type(name, style, bowl_type, bowl, known):
    if name in known:
        return known[name]
    t = type_from_style(style)
    if t:
        return t
    if bowl_type and bowl >= 30:
        return 'RFM' if bowl_type == 'pace' else 'OB'
    return None


def load_positions():
    pos = {}
    for line in open(os.path.join(ROOT, 'tools', 'batting_positions.txt')):
        line = line.strip()
        if line and not line.startswith('#'):
            name, p = line.split('|')
            bands = p.split(',')
            assert all(b in BANDS for b in bands), line
            pos[name] = bands
    return pos


def default_bands(role, bat, bowl):
    """Where a player bats if we have no better knowledge."""
    if role == 'BOWL' or bat < 35:
        return ['tail']
    if role == 'AR':
        return ['middle', 'lower'] if bat >= 65 else ['lower'] if bat >= 45 else ['tail']
    if role == 'WK':
        return ['top', 'middle'] if bat >= 74 else ['middle', 'lower']
    return ['top'] if bat >= 72 else ['middle']


def load_dobs():
    """Birth dates for retained players, from Wikidata plus hand corrections."""
    dob = json.load(open(os.path.join(ROOT, 'tools', 'raw', 'ipl-2026', 'retained_dob_wikidata.json')))
    for line in open(os.path.join(ROOT, 'tools', 'retained_dob_overrides.txt')):
        line = line.strip()
        if line and not line.startswith('#'):
            name, d = line.split('|')
            dob[name] = d.rstrip('~')
    return dob


def age_on(dob, date):
    y, m, d = (int(x) for x in dob.split('-'))
    return date[0] - y - ((date[1], date[2]) < (m, d))


def overall(role, bat, bowl):
    if role in ('BAT', 'WK'):
        return bat + (2 if role == 'WK' else 0)
    if role == 'BOWL':
        return bowl
    hi, lo = max(bat, bowl), min(bat, bowl)
    # A genuine two-way player is worth more than either skill alone; one who rarely uses his
    # second skill (a batting all-rounder who bowls a few overs) is rated mainly on his main one.
    return round(max(hi * 0.75 + lo * 0.3, hi + max(0, lo - 30) * 0.1))


def norm(n):
    return re.sub(r'[^a-z]', '', n.lower())


def build(sid, cfg, cur, positions, dobs, all_names, btypes, bstyles, broles):
    raw = os.path.join(ROOT, 'tools', 'raw', sid)
    out_dir = os.path.join(ROOT, 'data', 'scenarios', sid)
    pool_raw = parse_pool(raw)
    retained, sold = parse_wiki(raw)
    used = set()
    players = []

    def add(base, rating, extra):
        pid = slug(base['name'])
        while pid in used:
            pid += '-2'
        used.add(pid)
        rec = dict(id=pid, name=base['name'], country=base['country'], overseas=base['country'] != 'India',
                   role=rating['role'], bowlType=rating['bowlType'], bat=rating['bat'], bowl=rating['bowl'])
        rec['ovr'] = overall(rec['role'], rec['bat'], rec['bowl'])
        rec['pos'] = positions.get(base['name']) or default_bands(rec['role'], rec['bat'], rec['bowl'])
        rec['bt'] = bowling_type(base['name'], base.get('bowlStyle'), rec['bowlType'], rec['bowl'], btypes)
        if base['name'] in bstyles:
            rec['bs'] = bstyles[base['name']]
        if base['name'] in broles:
            rec['br'] = broles[base['name']]
        rec.update(extra)
        players.append(rec)
        return rec

    names = [r['name'] for rows in retained.values() for r in rows]
    missing = [n for n in names if n not in dobs]
    if missing:
        raise SystemExit('%s: retained players without a birth date: %s' % (sid, missing))
    missing = [n for n in names if n not in cur]
    if missing:
        raise SystemExit('%s: retained players without curated ratings: %s' % (sid, missing))
    all_names.update(names)
    all_names.update(p['name'] for p in pool_raw)
    for tid, rows in retained.items():
        for r in rows:
            add(dict(name=r['name'], country=NAT.get(r['nat'], r['nat'])), cur[r['name']],
                dict(team=tid, price=r['salary'], retained=True, capped=r['name'] not in UNCAPPED_RETAINED,
                     age=age_on(dobs[r['name']], cfg['date'])))

    pool = []
    for p in pool_raw:
        c = cur.get(p['name']) or rate_from_stats(p)
        rec = add(p, c, dict(lot=p['lot'], set=p['set'], setCode=p['setCode'], base=p['base'], capped=p['capped'],
                             age=p['age'], batHand=p['batHand'], bowlStyle=p['bowlStyle'], prevTeam=p['prevTeam']))
        pool.append(rec['id'])

    # Actual results, matched to pool players by lot number, falling back to name.
    by_lot = {p['lot']: p for p in players if 'lot' in p}
    by_name = {norm(p['name']): p for p in players if 'lot' in p}
    actual = {}
    for s in sold:
        # Wikipedia uses the same lot numbers as the BCCI list, but spells some names differently.
        p = by_lot.get(s['lot']) or by_name.get(norm(s['name']))
        if not p:
            print('WARN: unmatched sold player', s)
            continue
        actual[p['id']] = dict(team=s['team'], price=s['price'], **({'rtm': True} if s['rtm'] else {}))

    teams = []
    for tid, name, c1, c2, home, group in TEAMS:
        ret = [p for p in players if p.get('team') == tid]
        t = dict(id=tid, name=name, color=c1, color2=c2, home=home, group=group, purse=cfg['purse'][tid],
                 retained=[p['id'] for p in ret])
        if cfg['rtm']:
            t['rtm'] = cfg['rtm'][tid]
        teams.append(t)
    meta = dict(id=sid, year=cfg['year'], kind=cfg['kind'], cap=cfg['cap'], venue=cfg['venue'], mainLastSet=cfg['main_sets'], champion=cfg['champion'], runnerUp=cfg['runner_up'],
                date='%04d-%02d-%02d' % cfg['date'])

    os.makedirs(out_dir, exist_ok=True)
    dump = lambda f, o: json.dump(o, open(os.path.join(out_dir, f), 'w'), separators=(',', ':'), ensure_ascii=False)
    dump('meta.json', meta)
    dump('players.json', players)
    dump('teams.json', teams)
    dump('pool.json', pool)
    dump('actual.json', actual)
    print('%s: players %d, pool %d, retained %d, actual sales %d (rtm %d)' % (
        sid, len(players), len(pool), sum(len(t['retained']) for t in teams), len(actual), sum(1 for a in actual.values() if a.get('rtm'))))


def build_retentions(year, wiki_path=None):
    """Real retentions for a season whose auction list is not out yet: data/scenarios/ipl-<year>/retentions.json.
    The app's IPL <year> mode then uses these instead of projected retentions. Players are matched to the
    previous season's data by name (with ALIASES)."""
    raw = os.path.join(ROOT, 'tools', 'raw', 'ipl-%d' % year)
    os.makedirs(raw, exist_ok=True)
    path = wiki_path or os.path.join(raw, 'pc.wiki')
    if not wiki_path:
        open(path, 'wb').write(http_get(WIKI_URL.format(year=year)))
    retained, _ = parse_wiki(os.path.dirname(path)) if os.path.basename(path) == 'pc.wiki' else (None, None)
    prev = json.load(open(os.path.join(ROOT, 'data', 'scenarios', 'ipl-%d' % (year - 1), 'players.json')))
    by_name = {norm(p['name']): p['id'] for p in prev}
    teams, missing = {}, []
    for tid, rows in retained.items():
        teams[tid] = []
        for r in rows:
            name = ALIASES.get(r['name'], r['name'])
            pid = by_name.get(norm(name))
            if not pid:
                missing.append(name)
                continue
            teams[tid].append(dict(id=pid, salary=r['salary']))
    out_dir = os.path.join(ROOT, 'data', 'scenarios', 'ipl-%d' % year)
    os.makedirs(out_dir, exist_ok=True)
    json.dump(dict(year=year, source=WIKI_URL.format(year=year), teams=teams, unmatched=missing),
              open(os.path.join(out_dir, 'retentions.json'), 'w'), indent=1, ensure_ascii=False)
    print('ipl-%d retentions: %d players, %d unmatched %s' % (year, sum(len(v) for v in teams.values()), len(missing), missing))


def check_new():
    """Is there a personnel-changes page with retentions for a season we have not built yet?"""
    year = max(c['year'] for c in SCENARIOS.values()) + 1
    try:
        w = http_get(WIKI_URL.format(year=year)).decode()
    except Exception:
        return None
    return year if '=== Retained players ===' in w and 'sortname' in w else None


def main():
    if '--retentions' in sys.argv:
        year = int(sys.argv[sys.argv.index('--retentions') + 1])
        src = sys.argv[sys.argv.index('--wiki') + 1] if '--wiki' in sys.argv else None
        build_retentions(year, src)
        return
    if '--check-new' in sys.argv:
        y = check_new()
        print(y or 'none')
        sys.exit(0 if y else 1)
    if '--fetch-wiki' in sys.argv:
        # Refresh only the Wikipedia sources (retentions, results). If the rebuild fails, put the old
        # files back so the scheduled job never commits broken data.
        import shutil
        backups = {}
        for sid, cfg in SCENARIOS.items():
            path = os.path.join(ROOT, 'tools', 'raw', sid, 'pc.wiki')
            backups[path] = open(path, 'rb').read()
            try:
                open(path, 'wb').write(http_get(WIKI_URL.format(year=cfg['year'])))
            except Exception as e:
                print('WARN: could not fetch %s: %s' % (sid, e))
        try:
            sys.argv = [a for a in sys.argv if a != '--fetch-wiki']
            main()
        except BaseException as e:
            for path, data in backups.items():
                open(path, 'wb').write(data)
            print('Rebuild failed (%s); restored the previous Wikipedia sources.' % e)
            sys.argv.append('--restored')
            main()
        return
    only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
    cur = load_curated()
    positions = load_positions()
    dobs = load_dobs()
    btypes = load_bowling_types()
    bstyles = load_pairs('batting_styles.txt', BAT_STYLES)
    broles = load_pairs('bowling_roles.txt', BOWL_ROLES, multi=True)
    all_names = set()
    for sid, cfg in SCENARIOS.items():
        if only and sid != only:
            continue
        if '--fetch' in sys.argv:
            fetch(sid, cfg)
        build(sid, cfg, cur, positions, dobs, all_names, btypes, bstyles, broles)
    if not only:
        unknown = [n for n in list(positions) + list(UNCAPPED_RETAINED) + list(btypes) + list(bstyles) + list(broles) if n not in all_names]
        if unknown:
            raise SystemExit('Names in position/uncapped lists that match no player: %s' % unknown)


if __name__ == '__main__':
    main()
