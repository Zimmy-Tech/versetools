"""
Raw search through Gladius forge XML for ALL numeric attributes that could be flight stats.
Also check thruster forge XMLs for thrust values.
Run: python find_flight_stats4.py
"""
from pathlib import Path
from xml.etree import ElementTree as ET
import re

FORGE   = Path(r"E:\VerseDB\sc_data_forge\libs\foundry\records")
VEHICLE = Path(r"E:\VerseDB\sc_data_xml\Data\Scripts\Entities\Vehicles\Implementations\Xml")

# ── 1. Dump the raw Gladius forge XML (first 8000 chars) ─────────────────────
ss_dir = FORGE / "entities" / "spaceships"
gladius_forge = ss_dir / "aegs_gladius.xml.xml"
if gladius_forge.exists():
    txt = gladius_forge.read_text(errors='replace')
    print(f"Gladius forge XML: {len(txt)} chars")
    # Print in chunks to find useful sections
    print("\n--- chars 0-3000 ---")
    print(txt[:3000])
    print("\n--- chars 3000-6000 ---")
    print(txt[3000:6000])
    print("\n--- chars 6000-9000 ---")
    print(txt[6000:9000])
else:
    print("Gladius forge XML not found")
    print("Available spaceships:")
    if ss_dir.exists():
        for f in sorted(ss_dir.glob("*.xml"))[:10]:
            print(f"  {f.name}")

# ── 2. Check the Gladius vehicle XML for thruster parts ──────────────────────
print("\n=== VEHICLE XML: thruster data ===")
for xml_file in VEHICLE.glob("*.xml"):
    if 'gladius' not in xml_file.name.lower(): continue
    root = ET.parse(xml_file).getroot()
    # Find thruster items and their params
    for part in root.iter("Part"):
        name = part.get("name","")
        if "thrust" in name.lower() or "engine" in name.lower():
            print(f"\nPart: {name}")
            for el in part.iter():
                if el.attrib:
                    relevant = {k:v for k,v in el.attrib.items()
                                if any(x in k.lower() for x in
                                   ['thrust','speed','accel','force','max','forward','retro',
                                    'lateral','up','down','pitch','yaw','roll'])}
                    if relevant:
                        print(f"  <{el.tag}: {relevant}>")
    # Also SSpaceship element
    for el in root.iter("SSpaceship"):
        print(f"\nSSpaceship: {dict(el.attrib)}")
    for el in root.iter("Spaceship"):
        print(f"\nSpaceship: {dict(el.attrib)}")
    break

# ── 3. Check thruster forge XMLs ─────────────────────────────────────────────
print("\n=== THRUSTER forge XMLs ===")
thruster_dir = FORGE / "entities" / "scitem" / "ships" / "thruster"
if not thruster_dir.exists():
    # Try alternate path
    for candidate in ["thrusters", "engine", "engines"]:
        d = FORGE / "entities" / "scitem" / "ships" / candidate
        if d.exists():
            thruster_dir = d
            break

if thruster_dir.exists():
    # Find Gladius main thruster
    for f in sorted(thruster_dir.glob("*.xml")):
        if 'gladius' in f.name.lower():
            print(f"\n{f.name}:")
            txt = f.read_text(errors='replace')
            print(txt[:1500])
            break
else:
    print("Thruster dir not found")
    # List what ship component folders exist
    ships_dir = FORGE / "entities" / "scitem" / "ships"
    if ships_dir.exists():
        for d in sorted(ships_dir.iterdir()):
            if d.is_dir():
                print(f"  {d.name}/")
