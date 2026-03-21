"""
Find default loadout for each ship via SItemPortLoadoutManualParams in DCB.
Run: python find_loadout_dcb5.py
"""
import struct, re
from pathlib import Path

DCB   = Path(r"E:\VerseDB\sc_data\Data\Game2.dcb")
FORGE = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records\entities\spaceships")

with open(DCB,"rb") as f: raw=f.read()
def u32(p): return struct.unpack_from("<I",raw,p)[0]
def i32(p): return struct.unpack_from("<i",raw,p)[0]
def u16(p): return struct.unpack_from("<H",raw,p)[0]

# ── Header parse (proven working from earlier scripts) ────────────────────────
pos=4; version=i32(pos); pos+=4
if version>=6: pos+=8
n_structs=i32(pos);pos+=4;n_props=i32(pos);pos+=4
n_enums=i32(pos);pos+=4;n_mappings=i32(pos);pos+=4;n_records=i32(pos);pos+=4
counts=[i32(pos+i*4) for i in range(19)];pos+=76
(c_bool,c_i8,c_i16,c_i32,c_i64,c_u8,c_u16,c_u32,c_u64,c_f32,
 c_f64,c_guid,c_str,c_loc,c_enum,c_strong,c_weak,c_ref,c_enum_opts)=counts
text_len=u32(pos);pos+=4;blob_len=u32(pos);pos+=4

struct_defs=[]
for _ in range(n_structs):
    struct_defs.append((u32(pos),u32(pos+4),u16(pos+8),u16(pos+10),u32(pos+12)));pos+=16
prop_defs=[]
for _ in range(n_props):
    prop_defs.append((u32(pos),u16(pos+6),u16(pos+8)));pos+=12
pos+=n_enums*8
mappings=[]
for _ in range(n_mappings):
    mappings.append((u32(pos),u32(pos+4)));pos+=8
rec_start=pos; pos+=n_records*32

# Value arrays in correct order
pos+=c_i8; pos+=c_i16*2; pos+=c_i32*4; pos+=c_i64*8
pos+=c_u8; pos+=c_u16*2; pos+=c_u32*4; pos+=c_u64*8
pos+=c_bool; pos+=c_f32*4; pos+=c_f64*8
pos+=c_guid*16; pos+=c_str*4; pos+=c_loc*4; pos+=c_enum*4
pos+=c_strong*8; pos+=c_weak*8; pos+=c_ref*20; pos+=c_enum_opts*4

text_start=pos; blob_start=text_start+text_len; data_start=blob_start+blob_len

def blob(off): p=blob_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')
def text_at(off): p=text_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')

struct_by_name={}
for i,(name_off,_,_,_,_) in enumerate(struct_defs):
    try: struct_by_name[blob(name_off)]=i
    except: pass

struct_data={}
off=data_start
for cnt,si in mappings:
    if si<len(struct_defs):
        struct_data[si]=(off,cnt); off+=struct_defs[si][4]*cnt

# ── Find structs ──────────────────────────────────────────────────────────────
loadout_si = struct_by_name.get("SItemPortLoadoutManualParams")
entry_si   = struct_by_name.get("SItemPortLoadoutEntryParams")
print(f"loadout_si={loadout_si}  entry_si={entry_si}")
print(f"loadout in struct_data: {loadout_si in struct_data}")
print(f"entry in struct_data: {entry_si in struct_data}")

# Search by partial name if not found
if entry_si is None:
    print("Searching for entry-related structs:")
    for name, idx in struct_by_name.items():
        if 'loadout' in name.lower() or 'entry' in name.lower():
            print(f"  {name} idx={idx}")

if loadout_si not in struct_data:
    print("loadout_si not in struct_data — checking mappings")
    for cnt, si in mappings:
        if si == loadout_si:
            print(f"  Found mapping: cnt={cnt} si={si}")

e_off, e_cnt = struct_data[entry_si]
e_rs = struct_defs[entry_si][4]
l_off, l_cnt = struct_data[loadout_si]
l_rs = struct_defs[loadout_si][4]
print(f"\nEntry: {e_cnt} instances x {e_rs} bytes")
print(f"Loadout: {l_cnt} instances x {l_rs} bytes")

def read_entry(idx):
    ei = e_off + idx*e_rs
    try: port = text_at(u32(ei+0))
    except: port = ""
    try: cls  = text_at(u32(ei+4))
    except: cls = ""
    return port, cls

# ── Brute-force decode ────────────────────────────────────────────────────────
HARDPOINT_WORDS = {'hardpoint','weapon','shield','power','cooler','quantum',
                   'turret','radar','slot','missile','bomb','landing','sensor'}

def is_valid_port(s):
    if not s or len(s) < 3 or len(s) > 80: return False
    sl = s.lower()
    return any(w in sl for w in HARDPOINT_WORDS)

def try_decode(var, label):
    inst = l_off + var*l_rs
    raw_l = raw[inst:inst+l_rs]
    print(f"\n{'='*50}")
    print(f"{label}  variant={var:#x}")
    print(f"hex: {' '.join(f'{b:02x}' for b in raw_l)}")

    for cnt_off in range(l_rs):
        for cnt_size in (1, 2, 4):
            if cnt_off+cnt_size > l_rs: continue
            if   cnt_size==1: cnt_v = raw_l[cnt_off]
            elif cnt_size==2: cnt_v = u16(inst+cnt_off)
            else:             cnt_v = u32(inst+cnt_off)
            if not (3 <= cnt_v <= 60): continue

            for idx_off in range(cnt_off+cnt_size, l_rs-3):
                idx_v = u32(inst+idx_off)
                if idx_v >= e_cnt or idx_v+cnt_v > e_cnt: continue
                port0, cls0 = read_entry(idx_v)
                port1, _ = read_entry(idx_v+1) if cnt_v>1 else ("x","")
                if is_valid_port(port0) and is_valid_port(port1):
                    print(f"  count@+{cnt_off}(u{cnt_size*8})={cnt_v}  start@+{idx_off}={idx_v}")
                    for k in range(cnt_v):
                        port, cls = read_entry(idx_v+k)
                        print(f"    [{k:2d}] '{port}' -> '{cls}'")
                    return True
    return False

# Load ship loadout refs
ship_loadouts = {}
if FORGE.exists():
    for xml_file in sorted(FORGE.glob("*.xml")):
        cn = xml_file.stem.replace('.xml','').lower()
        if any(x in cn for x in ['_ai_','_pu_ai','_npc']): continue
        try:
            m = re.search(r'SItemPortLoadoutManualParams\[([0-9A-Fa-f]+)\]',
                          xml_file.read_text(errors='replace'))
            if m: ship_loadouts[cn] = int(m.group(1),16)
        except: pass

print(f"\nTotal ship loadout refs: {len(ship_loadouts)}")
for cn in ['aegs_gladius','aegs_eclipse','aegs_avenger_stalker','anvl_hornet_f7c','drak_buccaneer']:
    var = ship_loadouts.get(cn)
    if var is None:
        print(f"\n{cn}: not found")
        continue
    if var >= l_cnt:
        print(f"\n{cn}: variant {var} >= l_cnt {l_cnt}")
        continue
    try_decode(var, cn)
