"""
Dig into the Gladius forge XML for IFCS/flight params.
Run: python find_flight_stats3.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET
import re

FORGE = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records")

# Check the Gladius forge XML - print the full IFCS section
ss_dir = FORGE / "entities" / "spaceships"
for xml_file in ss_dir.glob("*.xml"):
    if 'gladius' not in xml_file.name.lower(): continue
    txt = xml_file.read_text(errors='replace')
    
    # Find the IFCS component section
    idx = txt.find('SIFCSComponent')
    if idx < 0: idx = txt.find('ifcs')
    if idx >= 0:
        print("=== IFCS section ===")
        print(txt[max(0,idx-100):idx+2000])
    
    # Find playerParams (has SCM, nav speeds)
    idx2 = txt.find('playerParams')
    if idx2 >= 0:
        print("\n=== playerParams ===")
        print(txt[idx2:idx2+800])
    
    # Find SCMMasterModeParams or masterMode
    for term in ['SCMVelocity','masterMode','maxSCMSpeed','afterburnerSpeed',
                 'navSpeed','maxSpeed','SCM','boostSpeed','LinearSpeed',
                 'rotationDamping','maxAngularVelocity','pitchSpeed','yawSpeed',
                 'SIFCSComponent','angularJerk','thrustCapacityForward']:
        m = re.search(term, txt, re.IGNORECASE)
        if m:
            start = max(0, m.start()-50)
            snippet = txt[start:m.start()+300].replace('\n','')
            print(f"\n{term}: ...{snippet[:250]}")
    break

# Also check the IFCS records folder more carefully
print("\n=== IFCS folder all files ===")
ifcs_dir = FORGE / "ifcs"
if ifcs_dir.exists():
    for f in sorted(ifcs_dir.glob("*.xml")):
        txt = f.read_text(errors='replace')
        print(f"\n{f.name}:")
        root = ET.parse(f).getroot()
        # Print all non-empty attrs
        attrs = {k:v for k,v in root.attrib.items() if v and not k.startswith('__') and k not in ('__type','__ref','__path')}
        for k,v in list(attrs.items())[:20]:
            print(f"  {k}={v}")

# Check capacitorassignment folder - might have SCM speeds
cap_dir = FORGE / "capacitorassignment"
if cap_dir.exists():
    print("\n=== capacitorassignment ===")
    for f in sorted(cap_dir.glob("*.xml"))[:3]:
        print(f"\n{f.name}:")
        root = ET.parse(f).getroot()
        for el in root.iter():
            if el.attrib:
                print(f"  <{el.tag} {dict(list(el.attrib.items())[:8])}>")
        break
