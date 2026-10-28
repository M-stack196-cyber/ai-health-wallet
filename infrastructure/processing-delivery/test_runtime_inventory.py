import unittest,tempfile,os,struct
from pathlib import Path
from runtime_inventory import inventory_tree,elf_dependencies,InventoryRefusal
class InventoryTests(unittest.TestCase):
    def test_exact_tree(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'app';p.mkdir();f=p/'worker.js';f.write_text('synthetic');f.chmod(0o444)
            self.assertEqual(len(inventory_tree(d,['app'])),1)
    def test_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'x').symlink_to('/dev/null')
            with self.assertRaises(InventoryRefusal):inventory_tree(d,['x'])
    def test_path_escape(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(InventoryRefusal):inventory_tree(d,['../x'])
    def test_writable(self):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/'x';f.write_text('synthetic');f.chmod(0o666)
            with self.assertRaises(InventoryRefusal):inventory_tree(d,['x'])
    def test_malformed_elf(self):
        for raw in [b'',b'\x7fELF'+bytes(60),b'not executable']:
            with self.assertRaises(InventoryRefusal):elf_dependencies(raw)
    def test_static_elf(self):
        b=bytearray(120);b[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<Q',b,32,64);struct.pack_into('<HH',b,54,56,1)
        self.assertEqual(elf_dependencies(bytes(b)),{'interpreter':None,'needed':[],'search_paths':[]})
    def test_elf_dynamic_library(self):
        b=bytearray(300);b[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<Q',b,32,64);struct.pack_into('<HH',b,54,56,2)
        struct.pack_into('<IIQQQQQQ',b,64,1,0,0,0,0,300,300,8);struct.pack_into('<IIQQQQQQ',b,120,2,0,176,176,0,64,64,8)
        for i,pair in enumerate([(5,240),(10,20),(1,1),(0,0)]):struct.pack_into('<qQ',b,176+16*i,*pair)
        b[240:251]=b'\0libc.so.6\0';self.assertEqual(elf_dependencies(bytes(b))['needed'],['libc.so.6'])
if __name__=='__main__':unittest.main()
