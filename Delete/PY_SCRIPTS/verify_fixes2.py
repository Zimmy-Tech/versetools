"""
Fix SPowerSegmentResourceUnit reading and find QD instance ordering.
"""
import struct, re
from pathlib import Path
from xml.etree import ElementTree as ET

FORGE = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records\entities\scitem\ships")
DCB   = Path(r"E:\VerseDB\sc_data\Data\Game2.dcb")

with open(DCB,"rb") as f: raw=f.read()
def u32(p): return struct.unpack_from("<I",raw,p)[0]
def i32(p): return struct.unpack_from("<i",raw,p)[0]
def u16(p): return struct.unpack_from("<H",raw,p)[0]
def f32(p): return struct.unpack_from("<f",raw,p)[0]

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
for _ in range(n_props): pos+=12
pos+=n_enums*8
mappings_raw=[]
for _ in range(n_mappings):
    mappings_raw.append((u32(pos),u32(pos+4)));pos+=8
rec_start=pos; pos+=n_records*32
va_i8=pos; pos+=c_i8
va_i16=pos; pos+=c_i16*2
va_i32=pos; pos+=c_i32*4
va_i64=pos; pos+=c_i64*8
va_u8=pos; pos+=c_u8
va_u16=pos; pos+=c_u16*2
va_u32=pos; pos+=c_u32*4
va_u64=pos; pos+=c_u64*8
va_bool=pos; pos+=c_bool
va_f32_off=pos; pos+=c_f32*4
va_f64_off=pos; pos+=c_f64*8
pos+=c_guid*16+c_str*4+c_loc*4+c_enum*4
va_strong_off=pos; pos+=c_strong*8
va_weak_off=pos; pos+=c_weak*8
pos+=c_ref*20+c_enum_opts*4
text_start=pos; blob_start=text_start+text_len; data_start=blob_start+blob_len

def blob(off): p=blob_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')
def text(off): p=text_start+off; return raw[p:raw.index(b'\x00',p)].decode('utf-8','replace')

struct_by_name={}
for i,(name_off,_,_,_,_) in enumerate(struct_defs):
    try: struct_by_name[blob(name_off)]=i
    except: pass

struct_data={}
off=data_start
for cnt,si in mappings_raw:
    if si<len(struct_defs):
        struct_data[si]=(off,cnt); off+=struct_defs[si][4]*cnt

sru_si  = struct_by_name.get("SStandardResourceUnit")
psru_si = struct_by_name.get("SPowerSegmentResourceUnit")
qd_si   = struct_by_name.get("SCItemQuantumDriveParams")
ecd_si  = struct_by_name.get("EntityClassDefinition")

print(f"PSRU struct_idx={psru_si}, instances={struct_data.get(psru_si,(0,0))[1]}")
print(f"QD struct_idx={qd_si}, instances={struct_data.get(qd_si,(0,0))[1]}")

psru_off, psru_cnt = struct_data[psru_si]
psru_rs = struct_defs[psru_si][4]
qd_off,  qd_cnt   = struct_data[qd_si]
qd_rs = struct_defs[qd_si][4]

print(f"PSRU rec_size={psru_rs}, data offset={psru_off:#x}")

# Check PSRU raw bytes
print("\n=== PSRU raw bytes (first 10 instances) ===")
for i in range(10):
    inst = psru_off + i*psru_rs
    raw_bytes = raw[inst:inst+psru_rs]
    hex_str = ' '.join(f'{b:02x}' for b in raw_bytes)
    fval = f32(inst) if psru_rs >= 4 else 0
    u32val = u32(inst) if psru_rs >= 4 else 0
    # Also look up via va_f32 if it's an index
    va_lookup = f32(va_f32_off + u32val*4) if u32val < c_f32 else None
    va_str = f"{va_lookup:.4f}" if va_lookup is not None else "N/A"
    print(f"  [{i:3d}] {hex_str}  direct_f32={fval:.4f}  as_idx->{va_str}")

# Check instance 151 (PSRU[0097]) which should be ~23 power segments
print(f"\nPSRU[0097=dec151]:")
inst151 = psru_off + 151*psru_rs
raw151 = raw[inst151:inst151+psru_rs]
print(f"  hex: {' '.join(f'{b:02x}' for b in raw151)}")
print(f"  direct f32: {f32(inst151):.4f}")
u32_151 = u32(inst151)
print(f"  as u32 index: {u32_151} -> va_f32[{u32_151}]={f32(va_f32_off+u32_151*4) if u32_151<c_f32 else 'OOB'}")

# ── QD instance ordering ───────────────────────────────────────────────────────
print("\n=== QD instance ordering ===")
# The 62 QD ECD records are in filepath order in the text section
# Their variants (ECD instance indices) don't directly give QD instance index
# But: the QD data block instances ARE ordered by the mappings table
# And the mappings table processes struct types in a deterministic order
# 
# Key insight: find the MAPPING INDEX for SCItemQuantumDriveParams
# and look at which QD instances are created BEFORE it
# The instances are assigned in the order items are loaded
#
# Alternative: the ECD records appear in a specific order in the records table
# Sort them by record index -> that gives the QD instance order
print("QD ECD records sorted by record index:")
qd_ecd_recs = []
for ri in range(n_records):
    rp = rec_start + ri*32
    if u32(rp+8) != ecd_si: continue
    try: 
        fp_str = text(u32(rp+4)).lower()
        if 'qdrv' not in fp_str: continue
        cn = fp_str.split('/')[-1].replace('.xml','')
        variant = u16(rp+28)
        qd_ecd_recs.append((ri, cn, variant))
    except: pass

qd_ecd_recs.sort(key=lambda x: x[0])
print(f"Total: {len(qd_ecd_recs)} QD ECD records")
for ri, cn, var in qd_ecd_recs[:10]:
    print(f"  record[{ri}] '{cn}' ECD_variant={var}")

# The QD instances 0..61 are assigned as entities are loaded
# Each entity that HAS a SCItemQuantumDriveParams component gets an instance
# The ORDER of assignment matches the ORDER of ECD records in the records table
# (since records are processed in order)
# BUT: the variant is the ECD index, not the QD index
# 
# DIRECT APPROACH: scan the forge QD XMLs in the same order as the QD DCB instances
# by matching the ECD record order to forge XML sort order

# Let's check: do the template entries (first 4 records) correspond to
# QD instances 0,1,2,3? Templates are at record indices 78945-78948
# Non-template items start at record 89970
# That means templates are AFTER non-templates in the records table!
# So templates DO NOT correspond to QD instances 0-3

# Try: map ECD variant to QD instance index
# The ECD instances are loaded in record order
# For each ECD with a QD component, the QD instance is incremented
# But we don't know which ECDs have QD components without scanning all of them

# PRACTICAL SOLUTION: 
# We have 62 QD ECD records. We have 62 QD data instances.
# The records ARE in the order they appear in the records table.
# The QD instances ARE created in the same order (one per QD entity).
# So: sort QD ECD records by record index -> maps to QD instance 0..61

# BUT: are ALL these ECD records QD items, or are some shared components?
# From the names: qdrv_s01_template is a template (non-playable base)
# These templates likely still get QD instances allocated

# Let's test: map record-order to QD instance and check foxfire's speed
foxfire_record_pos = None
for i, (ri, cn, var) in enumerate(qd_ecd_recs):
    if 'foxfire' in cn:
        foxfire_record_pos = i
        print(f"\nFoxfire at record position {i} -> QD instance {i}")
        inst = qd_off + i*qd_rs
        v = struct.unpack_from("<4f",raw,inst)
        print(f"  QD[{i}]: speed={v[0]/1e6:.0f}Mm/s cal={v[1]:.1f}s")
        break
