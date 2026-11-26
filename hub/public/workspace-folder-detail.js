function paintWorkspaceDetail(host, folders, editable) {
  const summary = folders.trustSummary;
  if (!summary) {
    host.innerHTML = `<p>${folderStateLabel(folders.trustState)}</p>
      <p>${'참조 폴더 ' + folders.referenceCount}</p><p>이 PC에서 허브를 열어 폴더를 관리하세요.</p>`;
    return;
  }
  const row = (path, trust) => `<li><span>${esc(path || '폴더 확인 불가')}</span>
    ${trust?.state === 'unknown' ? '<span class="badge warn">경로 확인 불가</span>' : ''}</li>`;
  host.innerHTML = `<fieldset class="folder-fields">
    <h3>주 폴더</h3><ul>${row(folders.primaryCwd, summary.primary)}</ul>
    <h3>${'참조 폴더 ' + folders.referenceDirs.length}</h3>
    ${folders.referenceDirs.length ? `<ul>${folders.referenceDirs.map((path, i) => row(path, summary.refs[i])).join('')}</ul>` : '<p>참조 폴더 없음</p>'}
    ${folders.observedDirs?.length ? `<h3>감지된 폴더</h3><ul>${folders.observedDirs.map((path) => row(path)).join('')}</ul>` : ''}
    ${folders.managed && folders.applied?.revision !== folders.revision ? '<p>현재 실행에 적용된 폴더는 확인할 수 없습니다.</p>' : ''}
    ${editable ? '' : '<p>읽기 전용 세션입니다.</p>'}</fieldset>`;
}
