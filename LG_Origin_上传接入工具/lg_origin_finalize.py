#!/usr/bin/env python3
"""Create LG_Origin completion controls AFTER payload upload, outside the source directory."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

MANIFEST='_LG_ORIGIN_MANIFEST.json';READY='_LG_ORIGIN_READY.json'

def build(source,output,uri):
    source=source.resolve();output=output.resolve();parsed=urlsplit(uri)
    if not source.is_dir()or output==source or source in output.parents:raise ValueError('输出目录必须在数据目录之外')
    if parsed.scheme!='oss'or parsed.netloc!='hw-upload'or '/LG_Origin/'not in parsed.path or not uri.endswith('/')or parsed.path.rstrip('/').split('/')[-1]!=source.name:raise ValueError('OSS 来源目录与本地数据目录名称不匹配')
    if not re.fullmatch(r'PRT_[A-Za-z0-9]+_room[A-Za-z0-9]+R\d+_\d{4}-\d{2}-\d{2}-\d{6}',source.name):raise ValueError('数据文件夹名称格式无效')
    paths=sorted(source.rglob('*'));files=[]
    for path in paths:
        if path.is_symlink():raise ValueError('不支持符号链接：'+str(path))
        if not path.is_file():continue
        relative=path.relative_to(source).as_posix()
        if relative in {MANIFEST,READY}:raise ValueError('数据目录内已有完成标记；请先确认上传流程，避免提前上传完成标记')
        before=path.stat();digest=sha256()
        with path.open('rb')as stream:
            while True:
                chunk=stream.read(8*1024**2)
                if not chunk:break
                digest.update(chunk)
        after=path.stat()
        if (before.st_size,before.st_mtime_ns,before.st_ino)!=(after.st_size,after.st_mtime_ns,after.st_ino):raise ValueError('生成清单期间文件发生变化：'+relative)
        files.append({'path':relative,'size':after.st_size,'sha256':digest.hexdigest()})
    if not files:raise ValueError('数据目录为空')
    if paths!=sorted(source.rglob('*')):raise ValueError('生成清单期间目录发生变化')
    manifest=(json.dumps({'schema_version':1,'dataset_type':'LG_Origin','dataset_id':source.name,'files':files},ensure_ascii=False,indent=2)+'\n').encode()
    ready=(json.dumps({'schema_version':1,'manifest_sha256':sha256(manifest).hexdigest()},indent=2)+'\n').encode()
    output.mkdir(parents=True,exist_ok=True);(output/MANIFEST).write_bytes(manifest);(output/READY).write_bytes(ready)
    return {'files':len(files),'bytes':sum(f['size']for f in files),'manifest':str(output/MANIFEST),'ready':str(output/READY),'oss_uri':uri}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('source',type=Path);p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--oss-uri',required=True);a=p.parse_args()
    print(json.dumps(build(a.source,a.output_dir,a.oss_uri),ensure_ascii=False,indent=2))
    print('先完成全部业务文件上传，再上传 _LG_ORIGIN_MANIFEST.json，最后单独上传 _LG_ORIGIN_READY.json。完成后不要修改源目录。')
