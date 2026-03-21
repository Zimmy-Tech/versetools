"""
Find where flight performance data is stored for ships.
Check vehicle XMLs, forge XMLs, and ifcs folder.
Run: python find_flight_stats.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET
import re

FORGE   = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records")
VEHICLE = Path(r"E:\VerseDB\sc_data_xml\Data\Scripts\Entities\Vehicles\Implementations\Xml")

# Check vehicle XML
print("=== VEHICLE XML (Gladius) ===")
for xml_file in VEHICLE.glob("*.xml"):
    if 'gladius' in xml_file.name.lower():
        txt = xml_file.read_text(errors='replace')
        print(f"{xml_file.name}: {len(txt)} chars")
        for term in ['SCMVelocity','maxSpeed','ifcs','FullSpeed','SCM','angular','pitch',
                     'yaw','roll','MaxSpeed','LinearSpeed','SStandardFlightModel',
                     'Health','hp','mass','IFCSParams','SFlightModel']:
            m = re.search(term, txt, re.IGNORECASE)
            if m:
                start = max(0, m.start()-20)
                print(f"  {term}: ...{txt[start:m.start()+150]}")
        break

# Check forge spaceships
print("\n=== FORGE SPACESHIP (Gladius) ===")
ss_dir = FORGE / "entities" / "spaceships"
if ss_dir.exists():
    for f in ss_dir.glob("*.xml"):
        if 'gladius' in f.name.lower():
            txt = f.read_text(errors='replace')
            for term in ['ifcs','SCM','speed','Health','mass','Angular','Pitch']:
                m = re.search(term, txt, re.IGNORECASE)
                if m:
                    start = max(0, m.start()-10)
                    print(f"  {term}: {txt[start:m.start()+200][:200]}")
            break

# Check ifcs folder
print("\n=== IFCS FOLDER ===")
ifcs_dir = FORGE / "ifcs"
if ifcs_dir.exists():
    for f in sorted(ifcs_dir.glob("*.xml"))[:3]:
        txt = f.read_text(errors='replace')
        print(f"\n{f.name}:")
        print(txt[:400])
else:
    print("Not found")
    # Try alternative paths
    for path in ['vehicle', 'vehicles', 'flightmodel', 'flight']:
        d = FORGE / path
        if d.exists():
            print(f"Found: {d}")
            for f in list(d.glob("*.xml"))[:2]:
                print(f"  {f.name}")

# Check SHealthComponentParams in forge spaceship XMLs
print("\n=== HEALTH/MASS in Gladius forge XML ===")
if ss_dir.exists():
    for f in ss_dir.glob("*.xml"):
        if 'gladius' in f.name.lower():
            try:
                root = ET.parse(f).getroot()
                # Health
                for el in root.iter("SHealthComponentParams"):
                    print(f"  SHealthComponentParams: {dict(list(el.attrib.items())[:8])}")
                    break
                # Mass / physics
                for el in root.iter("SEntityPhysicsControllerParams"):
                    print(f"  SEntityPhysicsControllerParams: {dict(el.attrib)}")
                # IFCS
                for el in root.iter():
                    if 'ifcs' in el.tag.lower() or 'flight' in el.tag.lower() or 'speed' in el.tag.lower():
                        if el.attrib:
                            print(f"  <{el.tag} {dict(list(el.attrib.items())[:6])}>")
            except Exception as e:
                print(f"  Error: {e}")
            break
